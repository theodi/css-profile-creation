# CSS Profile Creation Component

A Community Solid Server component that adds comprehensive profile creation and management functionality with a modern UI and Mashlib integration.

## Features

- **Profile Creation**: Full-featured profile creation following SolidOS profile schema
- **Modern UI**: Beautiful, accessible form design with loading states
- **Mashlib Integration**: Includes Pivot data browser for visualizing Solid pods
- **Organization Management**: LinkedIn-style organization/CV section
- **Social Accounts**: Dynamic social media account management
- **Image Upload**: Support for both URL and file upload for profile photos
- **Advanced Options**: Toggle for advanced pod creation features

## Installation

```bash
npm install @theodi/css-profile-creation
```

## Usage

### Basic Setup

1. Install the component:
```bash
npm install @theodi/css-profile-creation
```

2. Install Mashlib (Pivot):
```bash
npm install @solid/pivot
```

3. Start the server with the profile creation configuration:
```bash
npx community-solid-server -c node_modules/@theodi/css-profile-creation/config/file-mashlib.json -f ./data
```

### Configuration

The component provides a main configuration file at `config/file-mashlib.json` that includes:
- Profile creation routes and handlers
- Mashlib/Pivot UI integration
- File-based storage
- All necessary identity handlers

### Custom Configuration

You can also import the profile components into your own configuration:

```json
{
  "@context": [
    "https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^7.0.0/components/context.jsonld"
  ],
  "import": [
    "css:config/identity/handler/base/default.json",
    "@theodi/css-profile-creation:config/identity/handler/default-with-profile.json"
  ]
}
```

## Component Structure

- **Source Code**: `src/identity/interaction/profile/ProfileHandler.ts`
- **Configurations**: `config/identity/handler/`
- **Templates**: `templates/identity/`
- **Styles**: `templates/styles/main.css`

## Profile Schema

The component follows the [SolidOS profile schema](https://github.com/SolidOS/profile-pane/blob/main/src/ontology/profileForm.ttl) and supports:

- Basic info (name, email, phone, nickname)
- Profile photo (URL or file upload)
- Pronouns
- Social media accounts
- Organizations/CV with LinkedIn-style display
- Skills and languages
- Contacts/friends (WebIDs)
- Profile styling (background/highlight colors)

## Development

### Building

```bash
npm run build
```

This will:
1. Compile TypeScript (`npm run build:ts`)
2. Generate Components.js metadata (`npm run build:components`)

### Project Structure

```
css-profile-creation/
├── src/                    # TypeScript source code
│   └── identity/
│       └── interaction/
│           └── profile/
│               └── ProfileHandler.ts
├── config/                 # Components.js configurations
│   └── identity/
│       └── handler/
├── templates/             # EJS templates and assets
│   ├── identity/
│   ├── styles/
│   └── scripts/
├── dist/                  # Compiled output (generated)
└── package.json
```

## Dependencies

- `@solid/community-server`: ^7.0.0
- `@solid/pivot`: ^1.0.0 (for Mashlib UI)
- `componentsjs`: ^5.0.0
- `n3`: ^1.0.0

## License

MIT

## Repository

https://github.com/theodi/css-profile-creation

