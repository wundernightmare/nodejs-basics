/**
 * A PgBouncer in front of the suite's Postgres — for the tests that establish
 * what works behind a connection pooler and what does not
 * (packages/database/src/pg-bouncer.integration.spec.ts). Unlike the shared
 * services of containers.global-setup.ts this one belongs to the suite that
 * starts it: its configuration is the subject of the test.
 *
 *   const bouncer = await startPgBouncer(infra.url("postgres"), { users: { app: "app" } });
 *   new Pool({ connectionString: bouncer.url("tx") });      // transaction pooling, 4 servers
 *   await bouncer.stop();
 *
 * Aliases: `tx` / `sess` (pool of 4), `tx_one` / `sess_one` (one server
 * connection) — transaction and session pooling over the same database.
 * The image is built from packages/testing/pgbouncer/Dockerfile (Alpine's
 * pgbouncer package) once and kept.
 */
import { fileURLToPath } from "node:url";

import { GenericContainer, Wait } from "testcontainers";

export interface PgBouncerOptions {
  /** user → password; each must exist in Postgres with that password. */
  users: Record<string, string>;
  /** `max_prepared_statements` (0 = PgBouncer does not track prepared statements). */
  maxPreparedStatements?: number;
  /** Seconds a client waits for a server connection before its query fails. */
  queryWaitTimeoutSeconds?: number;
  /** Startup parameters PgBouncer drops instead of refusing the connection. */
  ignoreStartupParameters?: string[];
}

export interface PgBouncer {
  /** A connection string through the pooler: the alias as database, `user` from `users`. */
  url(alias: "tx" | "sess" | "tx_one" | "sess_one", user?: string): string;
  stop(): Promise<void>;
}

const IMAGE = "nodejs-basics-test-pgbouncer:local";
const PORT = 6432;

export async function startPgBouncer(
  databaseUrl: string,
  options: PgBouncerOptions,
): Promise<PgBouncer> {
  const upstream = new URL(databaseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname);
  const target =
    `host=${local ? "host.docker.internal" : upstream.hostname} ` +
    `port=${upstream.port || "5432"} dbname=${upstream.pathname.slice(1)}`;
  const ini = `[databases]
tx = ${target} pool_mode=transaction pool_size=4
sess = ${target} pool_mode=session pool_size=4
tx_one = ${target} pool_mode=transaction pool_size=1
sess_one = ${target} pool_mode=session pool_size=1

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = ${PORT}
unix_socket_dir =
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
max_client_conn = 200
default_pool_size = 4
query_wait_timeout = ${options.queryWaitTimeoutSeconds ?? 2}
server_reset_query = DISCARD ALL
ignore_startup_parameters = ${["extra_float_digits", ...(options.ignoreStartupParameters ?? [])].join(",")}
max_prepared_statements = ${options.maxPreparedStatements ?? 0}
`;
  const userlist = Object.entries(options.users)
    .map(([user, password]) => `"${user}" "${password}"\n`)
    .join("");

  const context = fileURLToPath(new URL("../pgbouncer", import.meta.url));
  const image = await GenericContainer.fromDockerfile(context)
    .withBuildArgs({ DOCKER_HUB: process.env["DOCKER_HUB"] ?? "docker.io" })
    .build(IMAGE, { deleteOnExit: false });
  const container = await image
    .withCopyContentToContainer([
      { content: ini, target: "/etc/pgbouncer/pgbouncer.ini", mode: 0o644 },
      { content: userlist, target: "/etc/pgbouncer/userlist.txt", mode: 0o644 },
    ])
    .withExposedPorts(PORT)
    .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
    .withLabels({ "nodejs-basics.role": "integration-test" })
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const [firstUser = ""] = Object.keys(options.users);
  return {
    url(alias, user = firstUser) {
      const password = options.users[user];
      if (password === undefined) throw new Error(`pgbouncer: no user "${user}" in the userlist`);
      return (
        `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
        `@${container.getHost()}:${container.getMappedPort(PORT)}/${alias}`
      );
    },
    async stop() {
      await container.stop({ timeout: 0 });
    },
  };
}
