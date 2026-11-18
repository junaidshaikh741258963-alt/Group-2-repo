package com.tripcraft.backend.trains;

/**
 * The {@code new Error(message)} the TypeScript train providers throw.
 *
 * <p>The message is what {@code src/app/api/trains/route.ts} puts in the
 * {@code "error"} field of its 502 body, so these strings are copied
 * character-for-character from the TS.
 */
public class TrainSearchException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public TrainSearchException(String message) {
        super(message);
    }
}
