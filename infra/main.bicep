targetScope = 'resourceGroup'

@description('Azure region for all resources')
param location string

@description('Project name used for resource naming')
param projectName string

@description('Resource tags applied to all resources')
param tags object = {}

// --- User-Assigned Managed Identity for ACI ---

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${projectName}-identity'
  location: location
  tags: tags
}

// --- Module Deployments ---

module networking 'modules/networking.bicep' = {
  name: 'networking'
  params: {
    location: location
    projectName: projectName
    tags: tags
  }
}

module containerRegistry 'modules/container-registry.bicep' = {
  name: 'containerRegistry'
  params: {
    name: '${replace(projectName, '-', '')}acr${uniqueString(resourceGroup().id)}'
    location: location
    tags: tags
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'keyVault'
  params: {
    name: '${projectName}-kv-${uniqueString(resourceGroup().id)}'
    location: location
    principalId: managedIdentity.properties.principalId
    tags: tags
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    projectName: projectName
    tags: tags
  }
}

// --- Outputs ---

@description('Virtual Network resource ID')
output vnetId string = networking.outputs.vnetId

@description('Private subnet resource ID')
output privateSubnetId string = networking.outputs.privateSubnetId

@description('Proxy subnet resource ID')
output proxySubnetId string = networking.outputs.proxySubnetId

@description('ACR login server')
output acrLoginServer string = containerRegistry.outputs.loginServer

@description('ACR resource name')
output acrName string = containerRegistry.outputs.name

@description('ACR resource ID')
output acrId string = containerRegistry.outputs.id

@description('Key Vault URI')
output vaultUri string = keyVault.outputs.vaultUri

@description('Key Vault resource ID')
output vaultId string = keyVault.outputs.vaultId

@description('Key Vault name')
output vaultName string = keyVault.outputs.name

@description('Log Analytics workspace resource ID')
output workspaceId string = monitoring.outputs.workspaceId

@description('Log Analytics workspace customer ID')
output workspaceCustomerId string = monitoring.outputs.workspaceCustomerId

@description('Managed Identity resource ID')
output managedIdentityId string = managedIdentity.id

@description('Managed Identity client ID')
output managedIdentityClientId string = managedIdentity.properties.clientId

@description('Managed Identity principal ID')
output managedIdentityPrincipalId string = managedIdentity.properties.principalId
