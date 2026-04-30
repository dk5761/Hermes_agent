import "fastify";

export interface AuthedUser {
  id: string;
  username: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}
