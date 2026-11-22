export interface AppEnv {
  Bindings: Env;
  Variables: {
    /** Who is signed in to the admin: an email, or a service token's client id. */
    admin: string;
  };
}
