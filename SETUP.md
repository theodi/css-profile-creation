# Setup Instructions

This component provides profile creation functionality for Community Solid Server with Mashlib (Pivot) integration.

## Quick Start (For End Users)

1. **Install dependencies:**
```bash
npm install @theodi/css-profile-creation @solid/pivot
```

2. **Start the server:**
```bash
npx community-solid-server -c node_modules/@theodi/css-profile-creation/config/file-mashlib.json -f ./data
```

3. **Access the server:**
- Main interface: http://localhost:3000/
- Pods accessible via subdomains: http://username.localhost:3000/

## Development Setup (For Contributors)

If you're working on the source code of this component:

1. **Install dependencies:**
```bash
npm install
```

2. **Build the component:**
```bash
npm run build
```

3. **Start the server:**
```bash
npm start
```

The `npm start` command will:
- Link the package locally so Components.js can find it
- Clean up conflicting dependencies
- Start the Community Solid Server

**Note:** When running from source, the package must be linked using `npm link` so that Components.js can resolve the `@theodi/css-profile-creation` module. The `npm start` script handles this automatically.

## What This Configuration Provides

- **Mashlib/Pivot UI**: Full-featured data browser interface
- **Profile Creation**: Comprehensive profile management
- **File-based storage**: Data persisted to disk
- **Modern UI**: Beautiful, accessible forms
- **Advanced Options**: Toggle for pod creation features

## Features

- Create and edit user profiles
- Upload profile photos (URL or file)
- Manage organizations and CV
- Add social media accounts
- Browse pod data visually
- Full Solid protocol support

## Configuration Options

The main configuration file (`config/file-mashlib.json`) can be customized or you can import specific components into your own configuration.

## Notes

- Make sure to specify a data directory with the `-f` flag
- The server runs on port 3000 by default
- Pods use subdomain-based routing
- WebIDs are created at `profile/card#me` in each pod

