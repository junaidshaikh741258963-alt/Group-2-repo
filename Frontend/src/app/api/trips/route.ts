import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import crypto from "crypto";
import { badRequest, jsonError } from "@/server/errors";
import { log } from "@/server/log";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json({ trips: [] });
    }

    const trips = await query("SELECT * FROM trips WHERE user_id = ? ORDER BY created_at DESC", [
      userId,
    ]);

    return NextResponse.json({ trips });
  } catch (err) {
    // Contract: a missing/offline DB means "no server-saved trips", never an
    // error page. The trips page merges in localStorage trips either way.
    log.warn("[api/trips GET] db unavailable — returning empty list", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ trips: [] });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw badRequest("Invalid JSON body");

    const {
      userId,
      origin_name,
      destination_name,
      origin_lat,
      origin_lng,
      dest_lat,
      dest_lng,
      distance,
      duration,
    } = body as Record<string, unknown>;

    if (!userId || !origin_name || !destination_name) {
      throw badRequest("Missing required fields: userId, origin_name, destination_name");
    }

    const tripId = crypto.randomUUID();

    await query(
      `INSERT INTO trips (id, user_id, origin_name, destination_name, origin_lat, origin_lng, dest_lat, dest_lng, distance, duration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tripId,
        String(userId),
        String(origin_name),
        String(destination_name),
        Number(origin_lat) || null,
        Number(origin_lng) || null,
        Number(dest_lat) || null,
        Number(dest_lng) || null,
        Number(distance) || 0,
        Number(duration) || 0,
      ]
    );

    return NextResponse.json({ message: "Trip saved", id: tripId });
  } catch (err) {
    return jsonError(err, "api/trips POST");
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) throw badRequest("Trip ID required");

    await query("DELETE FROM trips WHERE id = ?", [id]);
    return NextResponse.json({ message: "Trip deleted" });
  } catch (err) {
    return jsonError(err, "api/trips DELETE");
  }
}
