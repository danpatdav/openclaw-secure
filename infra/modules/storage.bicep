@description('Azure region for storage resources')
param location string

@description('Project name used for resource naming')
param projectName string

@description('Resource tags')
param tags object = {}

@description('Principal ID of the managed identity for RBAC assignment')
param managedIdentityPrincipalId string

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

// --- RBAC: Storage Blob Data Contributor for Managed Identity ---

@description('Storage Blob Data Contributor role definition ID')
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, managedIdentityPrincipalId, storageBlobDataContributorRoleId)
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// --- Outputs ---

@description('Storage account name')
output storageAccountName string = storageAccount.name

@description('Storage account resource ID')
output storageAccountId string = storageAccount.id
