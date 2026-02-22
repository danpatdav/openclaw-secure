@description('ACR login server hostname')
param acrLoginServer string

@description('ACR resource name (used to retrieve admin credentials)')
param acrName string

@description('Analyzer container image reference (e.g. myacr.azurecr.io/analyzer:latest)')
param analyzerImage string

@description('Log Analytics workspace shared key')
@secure()
param workspaceKey string

@description('Resource ID of the analyzer subnet')
param analyzerSubnetId string

@description('Resource ID of the user-assigned managed identity')
param managedIdentityId string

@description('Anthropic API key (injected from Key Vault at deploy time)')
@secure()
param anthropicApiKey string

@description('OpenAI API key (injected from Key Vault at deploy time)')
@secure()
param openaiApiKey string

@description('Storage account name for agent memory')
param storageAccountName string

@description('Blob container name for agent memory')
param memoryContainerName string = 'agent-memory'

@description('Azure region for container groups')
param location string

@description('Project name for resource naming')
param projectName string = 'openclaw'

@description('Resource tags')
param tags object = {}

// Reference the existing ACR to retrieve admin credentials
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

// Reference the existing Log Analytics workspace for customer ID
resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' existing = {
  name: '${projectName}-logs'
}

// --- Analyzer Container Group ---

resource analyzerContainerGroup 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: '${projectName}-analyzer'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    osType: 'Linux'
    restartPolicy: 'Never'
    imageRegistryCredentials: [
      {
        server: acrLoginServer
        username: acr.listCredentials().username
        password: acr.listCredentials().passwords[0].value
      }
    ]
    subnetIds: [
      {
        id: analyzerSubnetId
      }
    ]
    containers: [
      {
        name: 'analyzer'
        properties: {
          image: analyzerImage
          resources: {
            requests: {
              cpu: 1
              memoryInGB: 1
            }
          }
          environmentVariables: [
            {
              name: 'ANTHROPIC_API_KEY'
              secureValue: anthropicApiKey
            }
            {
              name: 'OPENAI_API_KEY'
              secureValue: openaiApiKey
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_NAME'
              value: storageAccountName
            }
            {
              name: 'MEMORY_CONTAINER_NAME'
              value: memoryContainerName
            }
          ]
        }
      }
    ]
    diagnostics: {
      logAnalytics: {
        workspaceId: logWorkspace.properties.customerId
        workspaceKey: workspaceKey
        logType: 'ContainerInsights'
      }
    }
  }
}

@description('Analyzer container group resource ID')
output analyzerContainerGroupId string = analyzerContainerGroup.id
