package com.tripcraft.backend.rag;

import java.util.ArrayList;
import java.util.List;

/**
 * Everything a retriever may look at — {@code RetrievalContext} in
 * {@code src/lib/rag/types.ts}.
 */
public final class RetrievalContext {

    private String question = "";
    private List<ChatTurn> turns = List.of();
    private TripProfile profile = TripProfile.empty();
    private List<TripItemLite> tripItems = List.of();
    private String conversationId;
    private long now;

    private RetrievalContext() {
    }

    public static Builder builder() {
        return new Builder();
    }

    public String question() {
        return question;
    }

    public List<ChatTurn> turns() {
        return turns;
    }

    public TripProfile profile() {
        return profile;
    }

    public List<TripItemLite> tripItems() {
        return tripItems;
    }

    public String conversationId() {
        return conversationId;
    }

    public long now() {
        return now;
    }

    public static final class Builder {
        private final RetrievalContext ctx = new RetrievalContext();

        public Builder question(String question) {
            ctx.question = question == null ? "" : question;
            return this;
        }

        public Builder turns(List<ChatTurn> turns) {
            ctx.turns = turns == null ? List.of() : new ArrayList<>(turns);
            return this;
        }

        public Builder profile(TripProfile profile) {
            ctx.profile = profile == null ? TripProfile.empty() : profile;
            return this;
        }

        public Builder tripItems(List<TripItemLite> tripItems) {
            ctx.tripItems = tripItems == null ? List.of() : new ArrayList<>(tripItems);
            return this;
        }

        public Builder conversationId(String conversationId) {
            ctx.conversationId = conversationId;
            return this;
        }

        public Builder now(long now) {
            ctx.now = now;
            return this;
        }

        public RetrievalContext build() {
            return ctx;
        }
    }
}
