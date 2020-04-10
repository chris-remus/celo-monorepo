import { ensureLeading0x } from '@celo/utils/src/address'
import {
  clusterName,
  createIdentityIfNotExists,
  resourceGroup,
  subscriptionId,
} from 'src/lib/azure'
import { getFornoUrl } from 'src/lib/endpoints'
import { envVar, fetchEnv } from 'src/lib/env-utils'
import { AccountType, getPrivateKeysFor } from 'src/lib/generate_utils'
import { installGenericHelmChart, removeGenericHelmChart } from 'src/lib/helm_deploy'
import { execCmdWithExitOnFailure } from 'src/lib/utils'

const helmChartPath = '../helm-charts/oracle'

export async function installHelmChart(celoEnv: string) {
  return installGenericHelmChart(
    celoEnv,
    releaseName(celoEnv),
    helmChartPath,
    await helmParameters(celoEnv)
  )
}

export async function removeHelmRelease(celoEnv: string) {
  await removeGenericHelmChart(releaseName(celoEnv))
}

async function helmParameters(celoEnv: string) {
  const identity = await createOracleIdentityIfNotExists(celoEnv)
  const replicas = parseInt(fetchEnv(envVar.ORACLES), 10)
  const oraclePrivateKeys = getPrivateKeysFor(
    AccountType.PRICE_ORACLE,
    fetchEnv(envVar.MNEMONIC),
    replicas
  ).map((pkey) => `"${ensureLeading0x(pkey)}"`)

  return [
    `--set environmentName=${celoEnv}`,
    `--set replicas=${fetchEnv(envVar.ORACLES)}`,
    `--set image.repository=${fetchEnv(envVar.ORACLE_DOCKER_IMAGE_REPOSITORY)}`,
    `--set image.tag=${fetchEnv(envVar.ORACLE_DOCKER_IMAGE_TAG)}`,
    `--set oracle.web3ProviderUrl=${getFornoUrl(celoEnv)}`,
    `--set oracle.privateKeys=\\{${oraclePrivateKeys.join(',')}\\}`,
    `--set azure.subscriptionId=${subscriptionId()}`,
    `--set azure.identity.id=${identity.id}`,
    `--set azure.identity.clientId=${identity.clientId}`,
  ]
}

function releaseName(celoEnv: string) {
  return `${celoEnv}-oracle`
}

async function createOracleIdentityIfNotExists(celoEnv: string) {
  const identity = await createIdentityIfNotExists(oracleIdentityName(celoEnv))

  // Grant the service principal permission to manage the oracle identity.
  // See: https://github.com/Azure/aad-pod-identity#6-set-permissions-for-mic
  const [servicePrincipalClientId] = await execCmdWithExitOnFailure(
    `az aks show -n ${clusterName()} --query servicePrincipalProfile.clientId -g ${resourceGroup()} -o tsv`
  )
  await execCmdWithExitOnFailure(
    `az role assignment create --role "Managed Identity Operator" --assignee ${servicePrincipalClientId} --scope ${identity.id}`
  )

  // Allow the oracle identity to access the correct key vault
  await execCmdWithExitOnFailure(
    `az keyvault set-policy --name ${keyVaultName()} --key-permissions {get, list, sign} --object-id ${
      identity.principalId
    } -g ${resourceGroup()}`
  )
  return identity
}

function oracleIdentityName(celoEnv: string) {
  return `${celoEnv}-oracle`
}

function keyVaultName() {
  return fetchEnv(envVar.AZURE_ORACLE_KEY_VAULT_NAME)
}
