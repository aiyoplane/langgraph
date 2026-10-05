/**
 * Minimal end-to-end example of @aiyoplane/langgraph.
 *
 * Shows a two-node graph: plan (ungated) + deploy (gated). Runs in-process;
 * no network, no credentials.
 *
 * Run: node examples/minimal.js
 */

import { StateGraph, END } from '@langchain/langgraph';
import { createAiyoMcpAuthz, createLocalRdp } from '@aiyoplane/mcp-authz';
import {
  BlockedByPolicy,
  EscalationRequired,
  wrapNode,
} from '../src/index.js';

const policy = {
  rules: [
    { action_type: 'deploy', action_target: 'staging', effect: 'allow' },
    { action_type: 'deploy', action_target: 'production', effect: 'escalate' },
    { action_type: 'deploy', effect: 'block' },
  ],
};

const authz = createAiyoMcpAuthz({
  rdp: createLocalRdp({ policy }),
  toolConfig: {
    deploy_node: { aiyoGated: true, action: { type: 'deploy' } },
  },
});

const planNode = async (state) => ({
  plan: `Deploy ${state.artifactHash} to ${state.env}`,
});

const deployNode = async (state) => ({
  deployed: true,
  receipt: state.aeapReceipt ?? null,
});

const guardedDeploy = wrapNode(deployNode, {
  authz,
  toolName: 'deploy_node',
  intentBuilder: (state) => ({
    type: 'deploy',
    target: state.env,
    artifact: state.artifactHash,
  }),
});

const graph = new StateGraph({
  channels: {
    env: null,
    artifactHash: null,
    plan: null,
    deployed: null,
    receipt: null,
    aeapReceipt: null,
  },
})
  .addNode('plan', planNode)
  .addNode('deploy', guardedDeploy)
  .setEntryPoint('plan')
  .addEdge('plan', 'deploy')
  .addEdge('deploy', END);

const app = graph.compile();

async function main() {
  console.log('ALLOW case (staging):');
  const r1 = await app.invoke({ env: 'staging', artifactHash: 'sha256:abc' });
  console.log('  ', r1);

  console.log('\nESCALATE case (production):');
  try {
    await app.invoke({ env: 'production', artifactHash: 'sha256:def' });
  } catch (err) {
    if (err instanceof EscalationRequired) {
      console.log('  Held for escalation:', err.message);
    } else {
      throw err;
    }
  }

  console.log('\nBLOCK case (unknown env):');
  try {
    await app.invoke({ env: 'unknown', artifactHash: 'sha256:ghi' });
  } catch (err) {
    if (err instanceof BlockedByPolicy) {
      console.log('  Node did not execute:', err.message);
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
