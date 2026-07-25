# Some background

Tabby is an Electron app, with the frontend written in Typescript with the help of Angular framework. It's built using Webpack.

# Getting started

First of all, clone this repository.

# Install Dependencies
- [Node.js](https://nodejs.org/en/download/) **version 15 or newer*
- [Yarn](https://yarnpkg.com/)

## Windows native build requirements

Install **Visual Studio 2022 Build Tools** with the **Desktop development with C++** workload. In the *Individual components* tab, also select the Spectre-mitigated libraries for the MSVC toolset and target architecture you use (at minimum, **MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs**).

The `@tabby-gang/windows-process-tree` native module is compiled during dependency installation. Without these Spectre-mitigated libraries, MSBuild fails with `MSB8040` and the Windows native build cannot complete.

First, from within the `tabby` directory install the dependencies via yarn:

```
# macOS & Windows:
yarn
```

```
# Linux (Debian/Ubuntu here as an example)
sudo apt install libfontconfig-dev libsecret-1-dev libarchive-tools libnss3 libatk1.0-0 libatk-bridge2.0-0 libgdk-pixbuf2.0-0 libgtk-3-0 libgbm1 cmake
yarn
```

_⚠️Note: If you forked this repository, you may need to pull down the tags from this repository before installing node modules. `git pull --tags upstream master`_

Build Tabby:

```
yarn run build
```

Start Tabby

```
yarn start
```

# Building an installer

To build an installer, first complete a "normal" build as described above and then run:

```
node scripts/prepackage-plugins.mjs

node scripts/build-windows.mjs
# or
node scripts/build-linux.mjs
# or
node scripts/build-macos.mjs
```

The artifacts will be produced in the `dist` folder.

# Project layout
```
tabby
├─ app                                  # Electron app, just the bare essentials
|  ├─ src                               # Electron renderer code
|  └─ main.js                           # Electron main entry point
├─ build
├─ clink                                # Clink distribution, for Windows
├─ scripts                              # Maintenance scripts
├─ tabby-community-color-schemes     # Plugin that provides color schemes
├─ tabby-core                        # Plugin that provides base UI and tab management
├─ tabby-electron                    # Plugin that provides Electron-specific functions
├─ tabby-local                       # Plugin that provides local shells and profiles
├─ tabby-plugin-manager              # Plugin that installs other plugins
├─ tabby-settings                    # Plugin that provides the settings tab
├─ tabby-terminal                    # Plugin that provides terminal tabs
└─ tabby-web                         # Plugin that provides web-specific functions
```

# Plugin layout
```
tabby-pluginname
├─ src                                  # Typescript code
|  ├─ components                        # Angular components
|  |  ├─ foo.component.ts               # Code
|  |  ├─ foo.component.scss             # Styles
|  |  └─ foo.component.pug              # Template
|  ├─ services                          # Angular services
|  |  └─ foo.service.ts
|  ├─ api.ts                            # Publicly exported API
|  └─ index.ts                          # Module entry point
├─ package.json
├─ tsconfig.json
└─ webpack.config.js
```

# Plugins

The app will load all plugins from the source checkout in the dev mode, from the user's plugins directory at all times (click `Open Plugins Directory` under `Settings` > `Plugins`) and from the directory specified by the `TABBY_PLUGINS` environment var.

Only modules whose `package.json` file contains a `tabby-plugin` keyword will be loaded.

If you're currently in your plugin's directory, start Tabby as `TABBY_PLUGINS=$(pwd) tabby --debug`

A plugin should only provide a default export, which should be a `NgModule` class (or a `NgModuleWithDependencies` where applicable). This module will be injected as a dependency to the app's root module.

```javascript
import { NgModule } from '@angular/core'

@NgModule()
export default class MyModule {
  constructor () {
    console.log('Angular engaged, cap\'n.')
  }
}
```

Plugins provide functionality by exporting singular or multi providers:


```javascript
import { NgModule, Injectable } from '@angular/core'
import { ToolbarButtonProvider, ToolbarButton } from 'tabby-core'

@Injectable()
export class MyButtonProvider extends ToolbarButtonProvider {
    provide (): ToolbarButton[] {
        return [{
            icon: 'star',
            title: 'Foobar',
            weight: 10,
            click: () => {
                alert('Woohoo!')
            }
        }]
    }
}

@NgModule({
    providers: [
        { provide: ToolbarButtonProvider, useClass: MyButtonProvider, multi: true },
    ],
})
export default class MyModule { }
```


See `tabby-core/src/api.ts`, `tabby-settings/src/api.ts`, `tabby-local/src/api.ts` and `tabby-terminal/src/api.ts` for the available extension points.

Also check out [the example plugin](https://github.com/Eugeny/tabby-clippy).

Publish your plugin on NPM with a `tabby-plugin` keyword to make it appear in the Plugin Manager.
