import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Non connecté" });

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "Session invalide" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    const lastReset = new Date(profile.last_reset_at);
    const now = new Date();
    const diff = (now - lastReset) / 1000 / 3600;

    if (diff >= 24) {
      await supabase
        .from("profiles")
        .update({ tests_today: 0, last_reset_at: now.toISOString() })
        .eq("id", user.id);
      profile.tests_today = 0;
    }

    if (profile.plan === "free" && profile.tests_today >= 3) {
      const heuresRestantes = Math.ceil(24 - diff);
      return res.status(429).json({
        error: "limite_atteinte",
        message: `Limite atteinte. Revenez dans ${heuresRestantes}h ou passez Pro.`,
        upgrade_url: "/upgrade"
      });
    }

    const { image_base64, image_type, ad_type, objective } = req.body;
    if (!image_base64 || !ad_type || !objective) {
      return res.status(400).json({ error: "Données manquantes" });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: image_type || "image/jpeg",
              data: image_base64
            }
          },
          {
            type: "text",
            text: `Tu es un expert en publicité digitale. Analyse cette publicité.\n\nFormat : ${ad_type}\nObjectif : ${objective}\n\nStructure ta réponse ainsi :\n\n✅ POINTS FORTS\n- (2-3 points qui fonctionnent)\n\n🔧 AMÉLIORATIONS\n- (3-4 recommandations concrètes)\n\n📊 SCORE : X/10\n(une phrase de synthèse)`
          }
        ]
      }]
    });

    const aiResponse = response.content[0].text;

    await supabase
      .from("profiles")
      .update({
        tests_today: profile.tests_today + 1,
        total_analyses: profile.total_analyses + 1
      })
      .eq("id", user.id);

    await supabase.from("analyses").insert({
      user_id: user.id,
      ad_type,
      objective,
      ai_response: aiResponse
    });

    return res.status(200).json({
      advice: aiResponse,
      tests_remaining: profile.plan === "free" ? 2 - profile.tests_today : 999
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}
