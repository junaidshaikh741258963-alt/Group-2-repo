package com.tripcraft.backend.db;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import com.tripcraft.backend.config.EnvFile;

/**
 * Port of {@code src/lib/db.ts}.
 *
 * <p>Two-phase init, deliberately mirroring the original:
 * <ol>
 *   <li>{@link #ensureDatabaseExists()} runs <em>before</em> Spring builds its
 *       datasource, because a {@code jdbc:mysql://…/travel_planner} URL cannot
 *       connect to a schema that does not exist yet.</li>
 *   <li>{@link #initSchema()} creates the tables and seeds the guest row once
 *       a pooled connection is available.</li>
 * </ol>
 */
@Component
public class Database {

    private static final Logger log = LoggerFactory.getLogger(Database.class);

    /** Same statements, in the same order, as SCHEMA in db.ts. */
    private static final List<String> SCHEMA = List.of(
            """
            CREATE TABLE IF NOT EXISTS users (
              id VARCHAR(36) PRIMARY KEY,
              email VARCHAR(255) NOT NULL UNIQUE,
              password VARCHAR(255) NOT NULL,
              name VARCHAR(255),
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )""",
            """
            CREATE TABLE IF NOT EXISTS trips (
              id VARCHAR(36) PRIMARY KEY,
              user_id VARCHAR(36),
              origin_name VARCHAR(255),
              destination_name VARCHAR(255),
              origin_lat DOUBLE,
              origin_lng DOUBLE,
              dest_lat DOUBLE,
              dest_lng DOUBLE,
              distance DOUBLE,
              duration DOUBLE,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )""",
            "INSERT IGNORE INTO users (id, email, password, name) "
                    + "VALUES ('guest', 'guest@local', '-', 'Guest')");

    private final JdbcTemplate jdbc;

    @Autowired
    public Database(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Creates {@code CREATE DATABASE IF NOT EXISTS} over an admin connection
     * with no schema in the URL. Called from {@code main()} ahead of
     * {@code SpringApplication.run}.
     */
    public static void ensureDatabaseExists() {
        String host = EnvFile.get("DB_HOST");
        if (host == null || host.isEmpty()) {
            host = "localhost";
        }
        String port = EnvFile.get("DB_PORT");
        if (port == null || port.isEmpty()) {
            port = "3306";
        }
        String user = EnvFile.get("DB_USER");
        if (user == null || user.isEmpty()) {
            user = "root";
        }
        String password = EnvFile.get("DB_PASSWORD");
        if (password == null) {
            password = "";
        }
        String db = EnvFile.get("DB_NAME");
        if (db == null || db.isEmpty()) {
            db = "travel_planner";
        }

        String url = "jdbc:mysql://" + host + ":" + port
                + "/?useSSL=false&allowPublicKeyRetrieval=true&characterEncoding=utf8";
        try (Connection conn = DriverManager.getConnection(url, user, password);
             Statement st = conn.createStatement()) {
            st.execute("CREATE DATABASE IF NOT EXISTS `" + db
                    + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
            log.info("Database `{}` ready on {}:{}", db, host, port);
        } catch (SQLException e) {
            // Not fatal on its own: if the schema already exists the app still
            // starts, and Spring will surface a clear message if it cannot
            // actually connect.
            log.warn("Could not pre-create database `{}`: {}", db, e.getMessage());
        }
    }

    /** Runs every SCHEMA statement; all of them are IF NOT EXISTS / IGNORE. */
    public void initSchema() {
        for (String statement : SCHEMA) {
            jdbc.execute(statement);
        }
    }

    /** Mirrors {@code query()} in db.ts — rows keyed by column label. */
    public List<Map<String, Object>> query(String sql, Object... params) {
        return jdbc.queryForList(sql, params);
    }

    public int update(String sql, Object... params) {
        return jdbc.update(sql, params);
    }

    public JdbcTemplate jdbc() {
        return jdbc;
    }
}
