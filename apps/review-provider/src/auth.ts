import { type } from "arktype";

// Workerd permits schema compilation during startup, before requests arrive.
const Login = (() => {
  const Verifier = type("string").matching(/^[a-f0-9]{64}$/);

  return type({
    username: type("string").matching(/^[A-Za-z0-9_-]{1,128}$/),
    passwordSha256: Verifier,
    "retiring?": {
      passwordSha256: Verifier,
      retireAfterUtc: type("string")
        .narrow((value) => Number.isFinite(Date.parse(value)))
        .or("null"),
    },
  });
})();

type ReviewLogin = typeof Login.infer;

/** Configuration is a secret binding, never an API response or shipped client login. */
export function readLogin(secret: string | undefined): ReviewLogin | null {
  if (!secret || secret.length > 2048) return null;

  try {
    const value = Login(JSON.parse(secret));

    if (value instanceof type.errors) return null;

    return {
      username: value.username,
      passwordSha256: value.passwordSha256,
      ...(value.retiring && {
        retiring: {
          passwordSha256: value.retiring.passwordSha256,
          retireAfterUtc: value.retiring.retireAfterUtc,
        },
      }),
    };
  } catch {
    return null;
  }
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** Always compare fixed-size buffers, including the username and both password positions. */
export async function validLogin(
  username: string,
  password: string,
  login: ReviewLogin,
  now: number,
): Promise<boolean> {
  const text = new TextEncoder();

  const [givenUser, expectedUser, givenPassword] = await Promise.all([
    crypto.subtle.digest("SHA-256", text.encode(username)),
    crypto.subtle.digest("SHA-256", text.encode(login.username)),
    crypto.subtle.digest("SHA-256", text.encode(password)),
  ]);

  const sameUser = crypto.subtle.timingSafeEqual(givenUser, expectedUser);
  const current = crypto.subtle.timingSafeEqual(givenPassword, bytes(login.passwordSha256));

  const old = crypto.subtle.timingSafeEqual(
    givenPassword,
    bytes(login.retiring?.passwordSha256 ?? login.passwordSha256),
  );

  const retiringActive =
    login.retiring !== undefined &&
    (login.retiring.retireAfterUtc === null || now < Date.parse(login.retiring.retireAfterUtc));

  return sameUser && (current || (old && retiringActive));
}
