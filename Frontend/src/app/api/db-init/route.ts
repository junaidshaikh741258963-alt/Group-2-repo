import { NextResponse } from "next/server";
import { initDb } from "@/lib/db";

export async function GET() {
  try {
    await initDb();
    return NextResponse.json({ message: "Database initialized successfully" });
  } catch (err) {
    console.error("DB init error:", err);
    return NextResponse.json({ error: "Failed to initialize database" }, { status: 500 });
  }
}
