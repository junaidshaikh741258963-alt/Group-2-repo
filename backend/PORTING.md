# Porting brief — Next.js API → Spring Boot

You are porting TypeScript route handlers and their `src/lib/*` helpers to
Java 21 / Spring Boot 3.5.16. The frontend is already copied **unchanged** and
proxies `/api/*` to `localhost:8080`, so **nothing you write may change the
wire format.**

## 1. The spec

The TypeScript originals are the authority. Read them before writing Java and
keep them side by side.

```
C:\2. FODS Project\ai-travel-planner\src\app\api\**\route.ts     <- endpoints
C:\2. FODS Project\ai-travel-planner\src\lib\**                  <- helpers
```

Your Java output lives under:

```
C:\2. FODS Project\ai-travel-planner-better\backend\src\main\java\com\tripcraft\backend\
```

## 2. Package layout

| Package | Owns |
|---|---|
| `api` | `@RestController` classes, one per route (or per group) |
| `chat` | chat schema, prompts, turn intents, reply policies, streaming |
| `rag` | retrieval, ranking, tokenising, retrievers, knowledge store |
| `places` | OSM / nearby / route-places logic |
| `agentlib` | the `lib/agent/*` tools (currency, weather, flights, …) |
| `flights`, `trains`, `hotels` | domain searches |
| `external` | every third-party HTTP client (Groq, Ollama, SerpAPI, …) |
| `infra` | shared helpers — **already written, use them** |
| `db`, `config` | **already written** |

Do not create files outside the package(s) you were assigned.

## 3. Infrastructure already available

### `infra.Http` — the `fetch()` replacement

```java
Http.Raw raw = Http.get(url, timeoutMs);            // raw.status(), raw.body(), raw.ok(), raw.json()
Http.Raw raw = Http.post(url, body, headers, timeoutMs);
Http.Raw raw = Http.postJson(url, json, timeoutMs);
JsonNode node = Http.getJson(url, timeoutMs);       // null on non-2xx / bad JSON
String text  = Http.getText(url, timeoutMs);        // null on non-2xx
int status = Http.stream(url, headers, timeoutMs, sink);   // SSE / chunked bodies
```

`Http.Raw` deliberately does **not** throw on a non-2xx status, matching
`fetch` + `res.ok`. Timeout/network failures return status `0`.

### `infra.Json` — one `ObjectMapper`

```java
Json.M                       // the ObjectMapper
Json.parseOrNull(str)        // null instead of throwing
Json.write(obj)              // JSON.stringify equivalent
Json.obj() / Json.arr()      // builders
Json.optStr(n, "k", d)       // TS `n.k ?? d`, tolerant of missing/null/wrong type
Json.optNum / optInt / optBool
Json.arrOr(n, "k")           // "the field if it's an array, else []"
Json.elements(node)          // safe iteration, empty for non-arrays
```

### `external.SerpApiService`

```java
JsonNode data = serp.search(Map.of("engine","google_hotels","q",q)); // null => use free fallback
serp.search(params, timeoutMs);
serp.available();  serp.resolvePropertyToken(token, name);  serp.status();
```

**Never** call `serpapi.com` or read a SerpAPI key directly — this service is
the single funnel, exactly like `serpSearch()` in the TS.

### `db.Database`

```java
database.query(sql, params...);   // List<Map<String,Object>> — keys are column labels
database.update(sql, params...);
```

Schema DDL is already applied at startup (`db.SchemaInit`).

### `config.EnvFile`

```java
EnvFile.get("GROQ_API_KEY");   // reads .env.local, honours real env vars first
```

## 4. Controller conventions

```java
@RestController
@RequestMapping("/api/flights")          // class-level when the route has sub-paths
public class FlightsController {

    @PostMapping                    // no explicit name: -parameters is enabled
    public ResponseEntity<?> search(@RequestBody FlightReq req) { ... }
}
```

* `-parameters` is on in `pom.xml` — declare `@RequestParam String x`,
  `@RequestBody Foo foo` **without** quoting the name.
* Read body JSON as `JsonNode` unless a typed record is clearly better.
* Success → `ResponseEntity.ok(jsonNodeOrMap)`.
* Error → **status + `{"error": "<exact TS string>"}`**. Copy the message
  character-for-character from the route, including capitalisation and
  punctuation. The frontend renders these verbatim.
* 400 for validation, 500 for upstream failure, 404 where the TS says 404.
* Never leak a stack trace, key or provider payload to the client.

## 5. JSON shape rules

`application.yml` sets `spring.jackson.default-property-inclusion: non_null`,
so **null fields are omitted** — this is what you want for optional keys (TS
`JSON.stringify` omits `undefined` too).

* Optional text that must still appear → `""`, not `null`
  (`AiSchema.str()` semantics). Under `non_null`, `""` is kept and `null`
  would vanish.
* Optional numbers the model should omit → leave the field `null` and annotate
  the class/field with `@JsonInclude(JsonInclude.Include.NON_NULL)`.
* Field order is irrelevant; presence is not. When the TS always emits a key,
  your JSON must always emit it.

## 6. Compile and run

```powershell
$env:PATH="C:\Users\junai\AppData\Local\Temp\opencode\apache-maven-3.9.11\bin;$env:PATH"
Set-Location "C:\2. FODS Project\ai-travel-planner-better\backend"

# fast syntax/type check of just your files (use this while iterating)
$cp = (Get-Content cp.txt -Raw).Trim()
javac -encoding UTF-8 -parameters -d out-<yours> -cp "target\classes;$cp" <your .java files>

# full build
mvn -B -DskipTests compile
```

Delete your `out-<yours>` scratch directory when finished — only `target/` is
build output. `.gitignore` already covers `/backend/target/`, `/backend/out-*/`
and `*.class`.

**Never run two `mvn` commands at once** — concurrent builds corrupt `target/`.
Use `javac` for iteration and let the coordinator run the final `mvn`.

## 7. Environment limits — not yours to fix

These are shared free-tier quotas that also affected the original app. Do not
"fix" them, and do not weaken the code to hide them:

* **SerpAPI** shared key is out of monthly quota → `serp.search(...)` returns
  `null` → the code must fall back to free OSM/Wikimedia sources. `places: 0`
  for a non-Tokyo destination is the expected outcome, not a bug.
* **Groq** free tier is 8,000 TPM → occasional HTTP `429`. Surface it exactly
  as the TS does (stream `reset` + `error`), never retry in a loop.
* `v6.vbb.transport.rest` is unreachable → HAFAS returns `502`.

If a provider call fails, preserve the original control flow (fallbacks,
"sources" footer, empty-but-valid response) rather than throwing.

## 8. Quality bar

1. **Behaviour over line count** — reproduce control flow, fallbacks and
   ordering; don't invent cleaner abstractions.
2. Preserve **log wording** for anything a developer greps for
   (`[chat]`, `[serpapi]`, `DB init error:` …).
3. Preserve **streaming**: NDJSON events `delta` / `reset` / `done` / `error`,
   `content-type: application/x-ndjson`, chunked, `Cache-Control: no-cache,
   no-transform`.
4. No `Thread.sleep` in request paths; no unbounded retries.
5. Every file you write must compile with `javac` before you report done.
