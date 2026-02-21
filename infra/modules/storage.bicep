@description('Azure region for storage resources')
param location string

@description('Project name used for resource naming')
param projectName string

@description('Resource tags')
param tags object = {}

// --- Storage Account ---

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: '${replace(projectName, '-', '')}sa${uniqueString(resourceGroup().id)}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

// --- Blob Container ---

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource agentMemoryContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'agent-memory'
  properties: {
    publicAccess: 'None'
  }
}

// --- Lifecycle Policy: Auto-delete blobs after 7 days ---

resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-01-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-after-7-days'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 7
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'agent-memory/'
              ]
            }
          }
        }
      ]
    }
  }
}

// --- Outputs ---

@description('Storage account name')
output storageAccountName string = storageAccount.name

@description('Storage account resource ID')
output storageAccountId string = storageAccount.id
