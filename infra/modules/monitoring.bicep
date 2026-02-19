@description('Azure region for the Log Analytics workspace')
param location string

@description('Project name used for resource naming')
param projectName string

@description('Resource tags')
param tags object = {}

resource workspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${projectName}-logs'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 90
  }
}

@description('Log Analytics workspace resource ID')
output workspaceId string = workspace.id

@description('Log Analytics workspace customer ID (for container diagnostics)')
output workspaceCustomerId string = workspace.properties.customerId

@description('Log Analytics workspace shared key')
output workspaceSharedKey string = workspace.listKeys().primarySharedKey
