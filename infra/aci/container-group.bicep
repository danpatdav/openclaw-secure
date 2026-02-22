@description('ACR login server hostname')
param acrLoginServer string

@description('ACR resource name (used to retrieve admin credentials)')
param acrName string

@description('Proxy container image reference (e.g. myacr.azurecr.io/proxy:latest)')
param proxyImage string

@description('OpenClaw container image reference (e.g. myacr.azurecr.io/openclaw:latest)')
param openclawImage string

@description('Log Analytics workspace shared key')
@secure()
param workspaceKey string

@description('Resource ID of the private subnet for OpenClaw')
param privateSubnetId string

@description('Resource ID of the proxy subnet')
param proxySubnetId string

@description('Resource ID of the user-assigned managed identity')
param managedIdentityId string

@description('Azure region for container groups')
param location string

@description('Project name for resource naming')
param projectName string = 'openclaw'

@description('MVP level for allowlist config selection')
param mvpLevel string = 'mvp0'

@description('Anthropic API key (injected from Key Vault at deploy time)')
@secure()
param anthropicApiKey string

@description('Moltbook API key (injected from Key Vault at deploy time)')
@secure()
param moltbookApiKey string

@description('Storage account name for agent memory')
param storageAccountName string

@description('Blob container name for agent memory')
param memoryContainerName string = 'agent-memory'

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

// --- Proxy Container Group ---

resource proxyContainerGroup 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: '${projectName}-proxy'
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
    restartPolicy: 'Always'
    imageRegistryCredentials: [
      {
        server: acrLoginServer
        username: acr.listCredentials().username
        password: acr.listCredentials().passwords[0].value
      }
    ]
    subnetIds: [
      {
        id: proxySubnetId
      }
    ]
    containers: [
      {
        name: 'proxy'
        properties: {
          image: proxyImage
          ports: [
            {
              port: 3128
              protocol: 'TCP'
            }
          ]
          resources: {
            requests: {
              cpu: 1
              memoryInGB: 1
            }
          }
          environmentVariables: [
            {
              name: 'PROXY_PORT'
              value: '3128'
            }
            {
              name: 'ALLOWLIST_CONFIG'
              value: './config/allowlist.${mvpLevel}.json'
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_NAME'
              value: storageAccountName
            }
            {
              name: 'MEMORY_CONTAINER_NAME'
              value: memoryContainerName
            }
            {
              name: 'MOLTBOOK_API_KEY'
              secureValue: moltbookApiKey
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

// --- OpenClaw Container Group ---

resource openclawContainerGroup 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: '${projectName}-openclaw'
  location: location
  tags: tags
  // dependsOn not needed — implicit via proxyContainerGroup.properties.ipAddress.ip references
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
        id: privateSubnetId
      }
    ]
    containers: [
      {
        name: 'openclaw'
        properties: {
          image: openclawImage
          resources: {
            requests: {
              cpu: 1
              memoryInGB: json('1.5')
            }
          }
          environmentVariables: [
            {
              name: 'HTTP_PROXY'
              value: 'http://${proxyContainerGroup.properties.ipAddress.ip}:3128'
            }
            {
              name: 'HTTPS_PROXY'
              value: 'http://${proxyContainerGroup.properties.ipAddress.ip}:3128'
            }
            {
              name: 'MEMORY_URL'
              value: 'http://${proxyContainerGroup.properties.ipAddress.ip}:3128/memory'
            }
            {
              name: 'PROXY_BASE_URL'
              value: 'http://${proxyContainerGroup.properties.ipAddress.ip}:3128'
            }
            {
              name: 'NO_PROXY'
              value: '168.63.129.16'
            }
            {
              name: 'ANTHROPIC_API_KEY'
              secureValue: anthropicApiKey
            }
            {
              name: 'MOLTBOOK_API_KEY'
              secureValue: moltbookApiKey
            }
            {
              name: 'RUN_DURATION_HOURS'
              value: '4'
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

@description('Proxy container group resource ID')
output proxyContainerGroupId string = proxyContainerGroup.id

@description('OpenClaw container group resource ID')
output openclawContainerGroupId string = openclawContainerGroup.id
