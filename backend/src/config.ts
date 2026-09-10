import * as os from 'os';
import * as path from 'path';

export type OrgName = 'registrar' | 'examcell' | 'audit';

const SAMPLES = process.env.FABRIC_SAMPLES ?? path.join(os.homedir(), 'fabric-samples');
const PEER_ORGS = path.join(SAMPLES, 'test-network', 'organizations', 'peerOrganizations');

export interface OrgConfig {
  mspId: string;
  peerEndpoint: string;
  peerHostAlias: string;
  cryptoPath: string;
  domain: string;
}

/**
 * Infrastructure names (org1.example.com) come from fabric-samples and
 * appear only in logs. The MSP ID is what carries meaning: it is what the
 * endorsement policy names. See network/fabric-config/msp-mapping.md.
 */
export const ORGS: Record<OrgName, OrgConfig> = {
  registrar: {
    mspId: 'RegistrarMSP',
    peerEndpoint: 'localhost:7051',
    peerHostAlias: 'peer0.org1.example.com',
    cryptoPath: path.join(PEER_ORGS, 'org1.example.com'),
    domain: 'org1.example.com',
  },
  examcell: {
    mspId: 'ExamCellMSP',
    peerEndpoint: 'localhost:9051',
    peerHostAlias: 'peer0.org2.example.com',
    cryptoPath: path.join(PEER_ORGS, 'org2.example.com'),
    domain: 'org2.example.com',
  },
  audit: {
    mspId: 'AuditMSP',
    peerEndpoint: 'localhost:11051',
    peerHostAlias: 'peer0.org3.example.com',
    cryptoPath: path.join(PEER_ORGS, 'org3.example.com'),
    domain: 'org3.example.com',
  },
};

export const CHANNEL_NAME = process.env.CHANNEL ?? 'attendance-channel';
export const CHAINCODE_NAME = process.env.CC_NAME ?? 'haazir';

/**
 * Endorsement requires both Registrar and ExamCell, so a submitted
 * transaction must gather endorsements from both peers. The gateway is
 * given both explicitly rather than relying on discovery, which needs
 * anchor peer configuration that a dev network does not always have.
 */
export const ENDORSING_ORGS: OrgName[] = ['registrar', 'examcell'];
