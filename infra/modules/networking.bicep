@description('Azure region for all networking resources')
param location string

@description('Project name used for resource naming')
param projectName string

@description('Resource tags')
param tags object = {}

// --- Network Security Groups ---

resource nsgPrivate 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${projectName}-nsg-private'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowProxyOutbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '3128'
          sourceAddressPrefix: '10.0.1.0/24'
          destinationAddressPrefix: '10.0.2.0/24'
          description: 'Allow outbound to proxy subnet on port 3128'
        }
      }
      {
        name: 'AllowDNSOutbound'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Udp'
          sourcePortRange: '*'
          destinationPortRange: '53'
          sourceAddressPrefix: '10.0.1.0/24'
          destinationAddressPrefix: '168.63.129.16'
          description: 'Allow DNS resolution via Azure DNS'
        }
      }
      {
        name: 'DenyAllOutbound'
        properties: {
          priority: 4000
          direction: 'Outbound'
          access: 'Deny'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
          description: 'Deny all other outbound traffic'
        }
      }
    ]
  }
}

resource nsgProxy 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${projectName}-nsg-proxy'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowInboundFromPrivate'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '3128'
          sourceAddressPrefix: '10.0.1.0/24'
          destinationAddressPrefix: '10.0.2.0/24'
          description: 'Allow inbound from private subnet on proxy port'
        }
      }
      {
        name: 'DenyAllInboundInternet'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
          description: 'Deny all inbound from Internet'
        }
      }
      {
        name: 'AllowHTTPSOutbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
          sourceAddressPrefix: '10.0.2.0/24'
          destinationAddressPrefix: 'Internet'
          // NSG allows HTTPS to any destination. Domain-level filtering is
          // enforced by the proxy application layer (allowlist.json).
          // This supports MVP1+ where multiple domains (Anthropic, Moltbook)
          // may resolve to different/changing IP ranges.
          description: 'Allow outbound HTTPS — proxy enforces domain allowlist'
        }
      }
      {
        name: 'AllowDNSOutbound'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Udp'
          sourcePortRange: '*'
          destinationPortRange: '53'
          sourceAddressPrefix: '10.0.2.0/24'
          destinationAddressPrefix: '168.63.129.16'
          description: 'Allow DNS resolution via Azure DNS for proxy'
        }
      }
      {
        name: 'DenyAllOutbound'
        properties: {
          priority: 4000
          direction: 'Outbound'
          access: 'Deny'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
          description: 'Deny all other outbound traffic from proxy subnet'
        }
      }
    ]
  }
}

// --- Virtual Network ---

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${projectName}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.0.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'private-subnet'
        properties: {
          addressPrefix: '10.0.1.0/24'
          networkSecurityGroup: {
            id: nsgPrivate.id
          }
          delegations: [
            {
              name: 'aci-delegation'
              properties: {
                serviceName: 'Microsoft.ContainerInstance/containerGroups'
              }
            }
          ]
        }
      }
      {
        name: 'proxy-subnet'
        properties: {
          addressPrefix: '10.0.2.0/24'
          networkSecurityGroup: {
            id: nsgProxy.id
          }
          delegations: [
            {
              name: 'aci-delegation'
              properties: {
                serviceName: 'Microsoft.ContainerInstance/containerGroups'
              }
            }
          ]
        }
      }
    ]
  }
}

@description('Resource ID of the virtual network')
output vnetId string = vnet.id

@description('Resource ID of the private (OpenClaw) subnet')
output privateSubnetId string = vnet.properties.subnets[0].id

@description('Resource ID of the proxy subnet')
output proxySubnetId string = vnet.properties.subnets[1].id
