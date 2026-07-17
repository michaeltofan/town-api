import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

export type SoftRegistrationResponseOptions = {
  challenge: string;
  rpID: string;
  origin: string;
  userVerified?: boolean;
  credentialIdBytes?: Uint8Array;
};

function toBase64Url(buffer: Uint8Array): string {
  return isoBase64URL.fromBuffer(new Uint8Array(buffer));
}

function buildAuthenticatorData(input: {
  rpID: string;
  credentialId: Uint8Array;
  cosePublicKey: Uint8Array;
  userVerified: boolean;
}): Buffer {
  const rpIdHash = createHash('sha256').update(input.rpID).digest();
  const flags = Buffer.from([0x01 | 0x40 | (input.userVerified ? 0x04 : 0x00)]);
  const counter = Buffer.alloc(4);
  const aaguid = Buffer.alloc(16);
  const credentialIdLength = Buffer.alloc(2);
  credentialIdLength.writeUInt16BE(input.credentialId.length, 0);

  return Buffer.concat([
    rpIdHash,
    flags,
    counter,
    aaguid,
    credentialIdLength,
    Buffer.from(input.credentialId),
    Buffer.from(input.cosePublicKey),
  ]);
}

function createEs256CoseKey(): Uint8Array {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('P-256 public key did not export affine coordinates');
  }

  return isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, isoBase64URL.toBuffer(jwk.x)],
      [-3, isoBase64URL.toBuffer(jwk.y)],
    ]),
  );
}

export function createSoftRegistrationResponse(
  options: SoftRegistrationResponseOptions,
): RegistrationResponseJSON {
  const credentialId = options.credentialIdBytes ?? randomBytes(32);
  const cosePublicKey = createEs256CoseKey();
  const authData = buildAuthenticatorData({
    rpID: options.rpID,
    credentialId,
    cosePublicKey,
    userVerified: options.userVerified ?? true,
  });
  const attestationObject = isoCBOR.encode(
    new Map<string, string | Uint8Array | Map<string, never>>([
      ['fmt', 'none'],
      ['attStmt', new Map<string, never>()],
      ['authData', authData],
    ]),
  );
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin: options.origin,
      crossOrigin: false,
    }),
    'utf8',
  );
  const credentialIdBase64Url = toBase64Url(credentialId);

  return {
    id: credentialIdBase64Url,
    rawId: credentialIdBase64Url,
    type: 'public-key',
    response: {
      clientDataJSON: toBase64Url(clientDataJSON),
      attestationObject: toBase64Url(attestationObject),
      transports: ['internal'],
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };
}
