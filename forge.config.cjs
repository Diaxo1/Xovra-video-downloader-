const path = require('node:path');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'xovra',
    extraResource: [path.join(__dirname, 'engine')],
    ignore: [new RegExp('[\\\\/]engine[\\\\/]')]
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32']
    },
    {
      name: '@electron-forge/maker-wix',
      platforms: ['win32'],
      config: {
        manufacturer: 'Xovra',
        name: 'Xovra',
        description: 'Local media workspace'
      }
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: { options: { name: 'xovra', bin: 'xovra', maintainer: 'Xovra' } }
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: { options: { name: 'xovra', bin: 'xovra' } }
    }
  ]
};
