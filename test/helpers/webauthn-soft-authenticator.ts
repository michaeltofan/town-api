import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

export type SoftRegistrationResponseOptions = {
  challenge: string;
  rpID: string;
  origin: string;
  userVerified?: boolean;
  credentialIdBytes?: Uint8Array;
  backedUp?: boolean;
};

export type SoftAuthenticationResponseOptions = {
  challenge: string;
  rpID: string;
  origin: string;
  userVerified?: boolean;
  signCount: number;
  userHandle?: Uint8Array;
};

export type SoftPasskeyMaterial = {
  credentialId: Uint8Array;
  credentialIdBase64Url: string;
  publicKeyCose: Uint8Array;
  privateKey: KeyObject;
  createRegistrationResponse: (
    options: SoftRegistrationResponseOptions,
  ) => RegistrationResponseJSON;
  createAuthenticationResponse: (
    options: SoftAuthenticationResponseOptions,
  ) => AuthenticationResponseJSON;
};

function toBase64Url(buffer: Uint8Array): string {
  return isoBase64URL.fromBuffer(new Uint8Array(buffer));
}

function createEs256CoseKey(publicKey: KeyObject): Uint8Array {
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

function buildRegistrationAuthenticatorData(input: {
  rpID: string;
  credentialId: Uint8Array;
  cosePublicKey: Uint8Array;
  userVerified: boolean;
  backedUp: boolean;
}): Buffer {
  const rpIdHash = createHash('sha256').update(input.rpID).digest();
  // UP | UV | AT | BE | BS(optional)
  let flags = 0x01 | 0x40 | 0x08 | (input.userVerified ? 0x04 : 0x00);
  if (input.backedUp) {
    flags |= 0x10;
  }
  const counter = Buffer.alloc(4);
  const aaguid = Buffer.alloc(16);
  const credentialIdLength = Buffer.alloc(2);
  credentialIdLength.writeUInt16BE(input.credentialId.length, 0);

  return Buffer.concat([
    rpIdHash,
    Buffer.from([flags]),
    counter,
    aaguid,
    credentialIdLength,
    Buffer.from(input.credentialId),
    Buffer.from(input.cosePublicKey),
  ]);
}

function buildAssertionAuthenticatorData(input: {
  rpID: string;
  userVerified: boolean;
  signCount: number;
  backedUp?: boolean;
}): Buffer {
  const rpIdHash = createHash('sha256').update(input.rpID).digest();
  let flags = 0x01 | 0x08 | (input.userVerified ? 0x04 : 0x00);
  if (input.backedUp) {
    flags |= 0x10;
  }
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(input.signCount >>> 0, 0);
  return Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);
}

export function createSoftPasskeyMaterial(credentialIdBytes?: Uint8Array): SoftPasskeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = credentialIdBytes ?? randomBytes(32);
  const publicKeyCose = createEs256CoseKey(publicKey);
  const credentialIdBase64Url = toBase64Url(credentialId);

  return {
    credentialId,
    credentialIdBase64Url,
    publicKeyCose,
    privateKey,
    createRegistrationResponse(options) {
      const authData = buildRegistrationAuthenticatorData({
        rpID: options.rpID,
        credentialId,
        cosePublicKey: publicKeyCose,
        userVerified: options.userVerified ?? true,
        backedUp: options.backedUp ?? true,
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
    },
    createAuthenticationResponse(options) {
      const authenticatorData = buildAssertionAuthenticatorData({
        rpID: options.rpID,
        userVerified: options.userVerified ?? true,
        signCount: options.signCount,
        backedUp: true,
      });
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: options.challenge,
          origin: options.origin,
          crossOrigin: false,
        }),
        'utf8',
      );
      const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
      const signature = createSign('SHA256')
        .update(Buffer.concat([authenticatorData, clientDataHash]))
        .sign(privateKey);

      return {
        id: credentialIdBase64Url,
        rawId: credentialIdBase64Url,
        type: 'public-key',
        response: {
          clientDataJSON: toBase64Url(clientDataJSON),
          authenticatorData: toBase64Url(authenticatorData),
          signature: toBase64Url(signature),
          ...(options.userHandle ? { userHandle: toBase64Url(options.userHandle) } : {}),
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
  };
}

/**
 * Backward-compatible registration fixture used by Slice 3 tests.
 * Generates an ephemeral soft authenticator for one-shot registration.
 */
export function createSoftRegistrationResponse(
  options: SoftRegistrationResponseOptions,
): RegistrationResponseJSON {
  const material = createSoftPasskeyMaterial(options.credentialIdBytes);
  return material.createRegistrationResponse(options);
}
