package com.tripcraft.backend;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

import com.tripcraft.backend.config.EnvFile;
import com.tripcraft.backend.db.Database;

/**
 * Replaces the Next.js API layer: every route under src/app/api was ported to
 * a Spring MVC controller, and the Next dev server proxies /api/* here via the
 * rewrite in next.config.ts.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class TravelPlannerApplication {

    public static void main(String[] args) {
        // Must run before the context is built: datasource credentials and the
        // provider API keys come from the frontend's .env.local.
        EnvFile.load();
        // The datasource URL names a schema that may not exist yet, so create
        // it over an admin connection before Spring opens its pool.
        Database.ensureDatabaseExists();
        SpringApplication.run(TravelPlannerApplication.class, args);
    }
}
