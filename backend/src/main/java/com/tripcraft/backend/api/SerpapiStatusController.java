package com.tripcraft.backend.api;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.external.SerpApiService;
import com.tripcraft.backend.infra.Json;

/**
 * Port of {@code src/app/api/serpapi-status/route.ts} — dev-only SerpAPI key
 * status. Never served in production (the TS checks
 * {@code NODE_ENV === "production"}; the Spring equivalent is the standard
 * {@code prod}/{@code production} active profile), and never leaks keys: the
 * payload carries only counts, indexes, months and reasons.
 */
@RestController
@RequestMapping("/api/serpapi-status")
public class SerpapiStatusController {

    private final SerpApiService serp;
    private final Environment env;

    @Autowired
    public SerpapiStatusController(SerpApiService serp, Environment env) {
        this.serp = serp;
        this.env = env;
    }

    @GetMapping
    public ResponseEntity<?> status() {
        if (env.acceptsProfiles(Profiles.of("prod", "production"))) {
            ObjectNode res = Json.obj();
            res.put("error", "Not found");
            return ResponseEntity.status(404).body(res);
        }
        JsonNode status = serp.status();
        return ResponseEntity.ok(status);
    }
}
