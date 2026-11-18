package com.tripcraft.backend.db;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.stereotype.Component;

/**
 * Stands in for {@code initDb()} in db.ts: the schema (and the guest seed row)
 * is guaranteed before any controller queries, so routes never race the DDL.
 */
@Component
public class SchemaInit implements InitializingBean {

    private static final Logger log = LoggerFactory.getLogger(SchemaInit.class);

    private final Database database;

    public SchemaInit(Database database) {
        this.database = database;
    }

    @Override
    public void afterPropertiesSet() {
        database.initSchema();
        log.info("Schema initialised (users, trips, guest seed)");
    }
}
