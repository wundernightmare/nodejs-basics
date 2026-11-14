/**
 * A certificate authority for one test run and what it issued — for the
 * suites that put a client in front of real TLS listeners. Generated with the
 * `openssl` command (Node cannot issue certificates itself); nothing here is
 * a secret and nothing is committed.
 *
 *   server   CN localhost; SAN localhost, host.docker.internal — no IP on purpose
 *   expired  the same names, expired yesterday
 *   client   for a listener that requires a client certificate
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Pki {
  /** The CA certificate: what a client must trust. */
  caPem: Buffer;
  serverCert: Buffer;
  serverKey: Buffer;
  expiredCert: Buffer;
  expiredKey: Buffer;
  clientCert: Buffer;
  clientKey: Buffer;
}

const CONFIG = `
[ ca ]
default_ca = test_ca

[ test_ca ]
dir               = .
database          = ./index.txt
new_certs_dir     = ./issued
serial            = ./serial
default_md        = sha256
policy            = any
unique_subject    = no
copy_extensions   = none

[ any ]
commonName = supplied

[ req ]
distinguished_name = dn
prompt             = no

[ dn ]
CN = integration CA

[ v3_ca ]
basicConstraints = critical, CA:TRUE
keyUsage         = critical, keyCertSign, digitalSignature

[ server ]
keyUsage         = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName   = DNS:localhost, DNS:host.docker.internal

[ client ]
keyUsage         = critical, digitalSignature
extendedKeyUsage = clientAuth
`;

/** `YYMMDDHHMMSSZ`, the form `openssl ca` takes for a validity bound. */
function utc(at: Date): string {
  return `${at.toISOString().replaceAll(/[-:T]/gu, "").slice(2, 14)}Z`;
}

export function createPki(): Pki {
  const dir = mkdtempSync(join(tmpdir(), "pki-"));
  const openssl = (args: string[]): void => {
    execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  };
  try {
    writeFileSync(join(dir, "openssl.cnf"), CONFIG);
    writeFileSync(join(dir, "index.txt"), "");
    writeFileSync(join(dir, "serial"), "1000\n");
    mkdirSync(join(dir, "issued"));

    const key = (name: string): void => {
      openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", name]);
    };
    key("ca.key");
    openssl(
      [
        ["req", "-x509", "-new", "-config", "openssl.cnf", "-extensions", "v3_ca"],
        ["-key", "ca.key", "-days", "2", "-out", "ca.crt"],
      ].flat(),
    );

    const day = 86_400_000;
    const now = Date.now();
    const issue = (
      name: string,
      cn: string,
      extensions: string,
      from: number,
      to: number,
    ): void => {
      key(`${name}.key`);
      openssl(["req", "-new", "-key", `${name}.key`, "-subj", `/CN=${cn}`, "-out", `${name}.csr`]);
      openssl(
        [
          ["ca", "-batch", "-config", "openssl.cnf", "-cert", "ca.crt", "-keyfile", "ca.key"],
          ["-extensions", extensions, "-startdate", utc(new Date(from))],
          ["-enddate", utc(new Date(to)), "-in", `${name}.csr`, "-out", `${name}.crt`, "-notext"],
        ].flat(),
      );
    };
    issue("server", "localhost", "server", now - 3_600_000, now + day);
    issue("expired", "localhost", "server", now - 2 * day, now - day);
    issue("client", "integration-client", "client", now - 3_600_000, now + day);

    const read = (name: string): Buffer => readFileSync(join(dir, name));
    return {
      caPem: read("ca.crt"),
      serverCert: read("server.crt"),
      serverKey: read("server.key"),
      expiredCert: read("expired.crt"),
      expiredKey: read("expired.key"),
      clientCert: read("client.crt"),
      clientKey: read("client.key"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
