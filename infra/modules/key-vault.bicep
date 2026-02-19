@description('Azure region for the Key Vault')
param location string

@description('Key Vault name (must be globally unique, 3-24 chars, alphanumeric and hyphens)')
param name string

@description('Principal ID of the managed identity that needs secret read access')
param principalId string

@description('Resource tags')
param tags object = {}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: false
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    accessPolicies: [
      {
        tenantId: subscription().tenantId
        objectId: principalId
        permissions: {
          secrets: [
            'get'
            'list'
          ]
        }
      }
    ]
  }
}

// Placeholder secret — value must be set manually post-deployment
resource anthropicApiKey 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'ANTHROPIC-API-KEY'
  properties: {
    value: 'REPLACE-ME-POST-DEPLOY'
    contentType: 'text/plain'
  }
}

@description('Key Vault URI')
output vaultUri string = keyVault.properties.vaultUri

@description('Key Vault resource ID')
output vaultId string = keyVault.id

@description('Key Vault name')
output name string = keyVault.name
