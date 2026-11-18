package com.tripcraft.backend.api;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.db.Database;
import com.tripcraft.backend.infra.Json;

/**
 * Port of {@code src/app/api/db-init/route.ts} — runs the schema DDL
 * ({@link Database#initSchema()}, the equivalent of the TS {@code initDb()})
 * on demand.
 */
@RestController
@RequestMapping("/api/db-init")
public class DbInitController {

    private static final Logger log = LoggerFactory.getLogger(DbInitController.class);

    private final Database database;

    @Autowired
    public DbInitController(Database database) {
        this.database = database;
    }

    @GetMapping
    public ResponseEntity<?> init() {
        try {
            database.initSchema();
            ObjectNode res = Json.obj();
            res.put("message", "Database initialized successfully");
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("DB init error:", err);
            ObjectNode res = Json.obj();
            res.put("error", "Failed to initialize database");
            return ResponseEntity.status(500).body(res);
        }
    }
}
