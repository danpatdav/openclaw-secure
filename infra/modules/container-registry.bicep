@description('Name for the Azure Container Registry (must be globally unique, alphanumeric)')
param name string

@description('Azure region for the container registry')
param location string

@description('Resource tags')
param tags object = {}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
  }
}

@description('ACR login server hostname')
output loginServer string = acr.properties.loginServer

@description('ACR resource name')
output name string = acr.name

@description('ACR resource ID')
output id string = acr.id
