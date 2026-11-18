package com.tripcraft.backend.rag;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The shared daemon thread pool the RAG pipeline runs its parallel legs on —
 * the Java counterpart of the {@code Promise.all} / detached-promise control
 * flow in the TypeScript retrievers.
 *
 * <p>Threads are daemons and unbounded-but-short-lived (cached pool): a leg
 * that outlives its budget keeps running in the background and finishes on its
 * own HTTP timeout, exactly like an un-awaited promise in the original.
 */
public final class RagExec {

    private RagExec() {
    }

    private static final AtomicInteger SEQ = new AtomicInteger();

    private static final ExecutorService POOL = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "rag-" + SEQ.incrementAndGet());
        thread.setDaemon(true);
        return thread;
    });

    public static ExecutorService pool() {
        return POOL;
    }
}
