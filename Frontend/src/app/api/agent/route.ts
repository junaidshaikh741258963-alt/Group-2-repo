import { NextRequest } from "next/server";
import { runAgent } from "@/lib/agent";
import { hasLlmConfig } from "@/lib/llm";

export async function POST(req: NextRequest) {
  try {
    if (!hasLlmConfig()) {
      return Response.json(
        {
          error:
            "AI provider not configured. Set API_KEY (plus MODEL_NAME and optionally BASE_URL) in .env.local",
        },
        { status: 500 }
      );
    }

    const form = await req.json();

    if (!form.destination || !form.startDate || !form.endDate) {
      return Response.json(
        { error: "Missing required fields: destination, startDate, endDate" },
        { status: 400 }
      );
    }

    const plan = await runAgent(form);

    return Response.json({ plan }, { status: 200 });
  } catch (error) {
    console.error("Agent error:", error);
    return Response.json(
      {
        error: "Agent failed to generate travel plan",
        details: "Something went wrong while generating your plan. Please try again.",
      },
      { status: 500 }
    );
  }
}
