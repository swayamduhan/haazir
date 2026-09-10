import * as grpc from '@grpc/grpc-js';
import { connect as gatewayConnect, Identity, signers } from '@hyperledger/fabric-gateway';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  CHAINCODE_NAME, CHANNEL_NAME, ENDORSING_ORGS, ORGS, OrgName,
} from '../config';
import { translateFabricError } from './errors';

export interface ContractHandle {
  submit(fn: string, ...args: string[]): Promise<string>;
  evaluate(fn: string, ...args: string[]): Promise<string>;
}

export interface GatewayHandle {
  contract(name: string): ContractHandle;
  close(): void;
}

async function firstFileIn(dir: string): Promise<string> {
  const [entry] = (await fs.readdir(dir)).sort();
  if (!entry) throw new Error(`no files found in ${dir}`);
  return path.join(dir, entry);
}

async function grpcClientFor(org: OrgName): Promise<grpc.Client> {
  const cfg = ORGS[org];
  const tlsCert = await fs.readFile(
    path.join(cfg.cryptoPath, 'peers', cfg.peerHostAlias, 'tls', 'ca.crt'),
  );
  return new grpc.Client(
    cfg.peerEndpoint,
    grpc.credentials.createSsl(tlsCert),
    { 'grpc.ssl_target_name_override': cfg.peerHostAlias },
  );
}

/**
 * Connects as the given organisation's admin.
 *
 * Submissions are endorsed by every organisation in ENDORSING_ORGS, because
 * the policy is AND(Registrar, ExamCell) and a transaction endorsed by one
 * alone is committed as invalid — silently, unless the caller waits for the
 * commit status, which submitTransaction does.
 */
export async function connect(org: OrgName): Promise<GatewayHandle> {
  const cfg = ORGS[org];
  const userMsp = path.join(cfg.cryptoPath, 'users', `Admin@${cfg.domain}`, 'msp');

  const client = await grpcClientFor(org);

  const identity: Identity = {
    mspId: cfg.mspId,
    credentials: await fs.readFile(await firstFileIn(path.join(userMsp, 'signcerts'))),
  };
  const privateKey = crypto.createPrivateKey(
    await fs.readFile(await firstFileIn(path.join(userMsp, 'keystore'))),
  );

  const endorsingOrgs = ENDORSING_ORGS.map((o) => ORGS[o].mspId);

  const gateway = gatewayConnect({
    client,
    identity,
    signer: signers.newPrivateKeySigner(privateKey),
  });
  const network = gateway.getNetwork(CHANNEL_NAME);

  return {
    contract(name: string): ContractHandle {
      const contract = network.getContract(CHAINCODE_NAME, name);
      return {
        async submit(fn, ...args) {
          try {
            const result = await contract.submit(fn, {
              arguments: args,
              endorsingOrganizations: endorsingOrgs,
            });
            return Buffer.from(result).toString();
          } catch (err) {
            const f = translateFabricError(err);
            // Keep the original: Fabric's error carries per-peer detail that
            // the flattened message loses, and it is what makes a rejection
            // diagnosable.
            throw Object.assign(new Error(`${f.code}: ${f.detail}`),
              { cause: err, fabric: f });
          }
        },
        async evaluate(fn, ...args) {
          try {
            const result = await contract.evaluate(fn, { arguments: args });
            return Buffer.from(result).toString();
          } catch (err) {
            const f = translateFabricError(err);
            // Keep the original: Fabric's error carries per-peer detail that
            // the flattened message loses, and it is what makes a rejection
            // diagnosable.
            throw Object.assign(new Error(`${f.code}: ${f.detail}`),
              { cause: err, fabric: f });
          }
        },
      };
    },
    close() {
      gateway.close();
      client.close();
    },
  };
}
