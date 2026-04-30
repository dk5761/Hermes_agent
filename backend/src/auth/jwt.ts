import jwt, { type SignOptions } from "jsonwebtoken";

export interface AccessTokenClaims {
  sub: string;
  username: string;
}

export interface JwtConfig {
  secret: string;
  accessTtl: string;
}

export function signAccessToken(claims: AccessTokenClaims, cfg: JwtConfig): string {
  return jwt.sign(claims, cfg.secret, {
    expiresIn: cfg.accessTtl as NonNullable<SignOptions["expiresIn"]>,
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string, cfg: JwtConfig): AccessTokenClaims {
  const decoded = jwt.verify(token, cfg.secret, { algorithms: ["HS256"] });
  if (typeof decoded === "string" || !decoded || typeof decoded !== "object") {
    throw new Error("Invalid token payload");
  }
  const sub = (decoded as Record<string, unknown>)["sub"];
  const username = (decoded as Record<string, unknown>)["username"];
  if (typeof sub !== "string" || typeof username !== "string") {
    throw new Error("Invalid token claims");
  }
  return { sub, username };
}
