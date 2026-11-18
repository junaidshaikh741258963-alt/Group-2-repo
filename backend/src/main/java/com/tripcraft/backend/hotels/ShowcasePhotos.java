package com.tripcraft.backend.hotels;

/**
 * Port of {@code src/lib/showcasePhotos.ts}.
 *
 * <p>The TypeScript imports the six bundled photos with webpack static
 * imports, so each {@code .src} is a content-hashed
 * {@code /_next/static/media/<name>.<hash>.jpg} URL baked in at frontend build
 * time. The backend cannot know that hash, so this port keeps the
 * project-relative asset paths instead; the map feeds {@code recImage()}'s
 * destination fallbacks, and the frontend's unchanged client copy resolves its
 * own bundled URLs for actual rendering.
 */
public final class ShowcasePhotos {

    private ShowcasePhotos() {
    }

    public static final String BALI = "/images/bali.jpg";
    public static final String MALDIVES = "/images/maldives.jpg";
    public static final String NEW_YORK = "/images/newyork.jpg";
    public static final String PARIS = "/images/paris.jpg";
    public static final String SANTORINI = "/images/santorini.jpg";
    public static final String TOKYO = "/images/tokyo.jpg";
}
