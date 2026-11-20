# AGENTS.md

This file provides guidance to Agents when working with code in this repository.

## Project Overview

This is a React web application for accessing Arweave content through the AR.IO Network using Wayfinder. It allows users to search by ArNS names or transaction IDs and view content through an optimized gateway routing system.

**Tech Stack**: React 18, TypeScript, Vite, Tailwind CSS, @ar.io/wayfinder-react

**Note**: This app requires Node.js crypto and buffer polyfills for browser compatibility. Polyfills are injected uniformly in both dev and build modes via `vite-plugin-node-polyfills` in `vite.config.ts` (including a separate plugin instance for the service worker build).

## Development Commands

```bash
# Development server (typically runs on http://localhost:5173)
npm run dev

# Production build (outputs to dist/)
npm run build

# Preview production build locally
npm run preview

# Run linter
npm run lint
```

## Dependencies

The app uses published AR.IO packages from npm:
- `@ar.io/wayfinder-react`: ^2.0.3
- `@ar.io/wayfinder-core`: ^2.1.0
- `@ar.io/sdk`: ^4.5.2 (for fetching trusted gateways by stake, initialized via `getArioClient()` in `src/utils/trustedGateways.ts:6-12` using `ARIO.init({ rpc })` with `createCircuitBreakerRpc({ primaryUrl: DEFAULT_SOLANA_RPC_URL })`)
- `vite-plugin-node-polyfills`: ^0.28.0 (`devDependencies`, provides browser polyfills for Node.js built-ins and `Buffer`/`global`/`process` globals)

For local development with unpublished Wayfinder changes, you can link to a sibling monorepo:

```json
{
  "@ar.io/wayfinder-react": "file:../wayfinder/packages/wayfinder-react",
  "@ar.io/wayfinder-core": "file:../wayfinder/packages/wayfinder-core"
}
```

If using local packages, ensure the Wayfinder monorepo is built first:

```bash
cd ../wayfinder
npm install
npm run build
cd ../wayfinder-app
npm install
```

## Architecture

### State Management Pattern

The app uses React Context for configuration management with localStorage persistence:

1. **WayfinderConfigContext** (`src/context/WayfinderConfigContext.tsx`): Manages user settings
   - Routing strategy selection (`random`, `fastest`, `roundRobin`, `preferred`)
   - Telemetry preferences
   - Content verification settings (`verificationEnabled`, `strictVerification`, `verificationConcurrency`, `verificationMethod`, `trustedGatewayCount`)
   - Auto-saves to localStorage on changes (key: `wayfinder-app-config`)

2. **WayfinderProvider** from `@ar.io/wayfinder-react`: Manages gateway routing and URL resolution
   - Receives configuration from `WayfinderWrapper` (`src/App.tsx:36-217`)
   - Re-initializes when routing config changes (via `key={routingKey}` in `src/App.tsx:213`)
   - Provides `useWayfinderUrl` hook for resolving `ar://` URLs to gateway URLs
   - **Critical**: Must be configured with `routingSettings.strategy` or it will have no gateways available
   - Fetches peers from AR.IO gateways (`turbo-gateway.com`, `permagate.io`, or host gateway) via `TrustedPeersGatewaysProvider`
   - Falls back to AR.IO SDK (`getArioClient()`) for gateway discovery if peer endpoints fail
   - Filters unhealthy gateways via `gatewayHealth.filterHealthy` and shuffles with `fisherYatesShuffleArray`
   - Wraps provider with `SimpleCacheGatewaysProvider` for 3-minute caching

### Component Hierarchy

```
App (WayfinderConfigProvider wrapper)
└── WayfinderWrapper (WayfinderProvider configuration)
    └── AppContent (Main UI state management)
        ├── SearchBar - Input UI with centered/top layout states
        │   - Displays resolved gateway URL link ("Routing via:") that opens in a new tab
        │   - Displays VerificationBadge in the toolbar when verification completes
        │   - Shows collapse/expand controls when content is loaded
        ├── Verification Mode (when verificationEnabled && swReady):
        │   ├── VerificationLoadingScreen - Phase/progress overlay during verification
        │   ├── Verified <iframe> (/ar-proxy/{searchInput}/)
        │   └── VerificationBlockedModal - Shown when strict mode blocks failed/partial verification
        ├── Direct Mode (ContentViewer) - Sandboxed iframe or PDF <object> using useWayfinderUrl
        │   - Memoized to prevent unnecessary re-renders
        │   - Runs pre-flight gateway health check before displaying content
        │   - Keyed by `${searchInput}-${searchCounter}` for retry mechanism
        └── SettingsFlyout - Settings panel (overlay)
```

**Key State Management**:
- `searchInput`: Current search query (synced with URL `?q=` parameter)
- `searchCounter`: Incremented on retry/search to force fresh ContentViewer/iframe mounting
- `resolvedUrl`: Current resolved gateway URL (displayed in `SearchBar` with a new-tab link)
- `swReady`: Service worker initialization state for verification mode
- `verificationState` / `verificationPhase` / `verificationStats`: Live verification lifecycle and progress

### Input Detection Logic

The app automatically detects input type using `detectInputType()` (`src/utils/detectInputType.ts:8-11`):

- **Transaction ID**: Exactly 43 characters matching `/^[A-Za-z0-9_-]{43}$/`
- **ArNS Name**: Everything else (1-51 chars, case-insensitive alphanumeric with dashes/underscores validated via `isValidInput()` at `src/utils/detectInputType.ts:16-23`)

`ContentViewer.tsx:19, 34-37` uses this to pass memoized params to `useWayfinderUrl`:
```typescript
const inputType = detectInputType(input);
...
const params = useMemo(
  () => (inputType === 'txId' ? { txId: input } : { arnsName: input }),
  [inputType, input]
);
```

### URL Resolution Flow

1. User enters ArNS name or txId → `SearchBar` (or via `?q=` URL parameter on page load)
2. Input validated and passed to `AppContent`
3. In direct mode, `ContentViewer` calls `detectInputType()` to determine param type
4. `useWayfinderUrl()` hook resolves `ar://` URL to gateway URL based on routing strategy
5. `ContentViewer` performs a pre-flight `checkGatewayHealth()` (`src/components/ContentViewer.tsx:42-66`) before loading the resolved URL in the iframe/PDF `<object>`
6. In verification mode, `AppContent` mounts an iframe targeting `/ar-proxy/{searchInput}/` (`src/App.tsx:639-649`) which triggers service worker verification

**URL Query Parameter Support**: The app reads the `?q=` parameter on mount (`src/App.tsx:251-259`) to auto-execute searches. When users search, the URL updates with the query parameter (`src/App.tsx:502-504`) to support browser back/forward navigation and direct links. Browser back/forward buttons are handled via the `popstate` event listener (`src/App.tsx:262-275`).

### Gateway Configuration

The app configures Wayfinder with a resilient, multi-layered gateway provider system (`src/App.tsx:40-206`):

1. **Resilient Gateway Fetching** (`src/App.tsx:72-132`): 5-tier fallback system with zero single points of failure
   - **Primary**: `turbo-gateway.com/ar-io/peers`
   - **Secondary**: `permagate.io/ar-io/peers`
   - **Tertiary**: `[host-gateway]/ar-io/peers` where host-gateway is extracted from the URL (`getHostGateway()` at `src/App.tsx:42-69`)
     - Example: viewing from `wayfinder.vilenarios.com` → tries `vilenarios.com/ar-io/peers`
     - Self-healing: if you can load the app, that gateway works!
   - **Quaternary**: AR.IO SDK (`getArioClient()`) queries the network contract for active joined gateways
   - **Ultimate Fallback**: `turbo-gateway.com` directly for content fetching

2. **Health Filtering & Gateway Limiting** (`src/App.tsx:135-156`): Filters out unhealthy gateways via `gatewayHealth.filterHealthy()` (clearing the cache if all are marked unhealthy) and randomly selects 20 gateways using `fisherYatesShuffleArray` (`src/App.tsx:26-33`)
   - Balanced between reliability and network load
   - Uses all available gateways if fewer than 20

3. **SimpleCacheGatewaysProvider** (`src/App.tsx:158-161`): Caches gateway list for 3 minutes
   - Allows fresh gateways on retry without excessive API calls
   - Cache is busted on manual retry via `gatewayRefreshCounter`

4. **createRoutingStrategy** (`src/App.tsx:164-188`): Maps user's routing strategy choice to Wayfinder routing strategy instances
   - `'roundRobin'` is mapped to `'balanced'` for `@ar.io/wayfinder-core`
   - `'preferred'` uses `StaticRoutingStrategy` which always returns the user's specified gateway (no ping checks or fallback)

5. **Auto-Retry System** (`src/components/ContentViewer.tsx:42-66, 82-107`): Automatically retries with fresh gateways on health-check or gateway/network errors
   - Up to `MAX_GATEWAY_AUTO_RETRIES` (3 auto-retries, defined in `src/utils/constants.ts:8`) before showing error/fallback
   - Each retry gets a new random set of 20 gateways
   - 500ms delay between `useWayfinderUrl` error retries to avoid hammering
   - Only retries on gateway/network errors (not 404s)

The routing strategy configuration is recreated whenever the user changes their routing preference, telemetry settings, or preferred gateway URL. The `WayfinderProvider` is keyed by routing strategy, preferred gateway, and `gatewayRefreshCounter` (`src/App.tsx:210-213`) to force re-initialization when needed.

### Gateway Retry Mechanism

When content fails to load, users can click "Retry with different gateway" which increments `searchCounter` and `gatewayRefreshCounter` (`src/App.tsx:507-540`). Both the verified iframe (`src/App.tsx:640`) and `ContentViewer` (`src/App.tsx:671`) are keyed by `${searchInput}-${searchCounter}`, forcing React to unmount and remount with a fresh gateway selection from the routing strategy.

### Settings Persistence

Settings are stored in localStorage with the key `wayfinder-app-config` (`src/utils/constants.ts:3`). `WayfinderConfigProvider` initializes from localStorage on mount (`src/context/WayfinderConfigContext.tsx:8-18`) and saves on every config change (`src/context/WayfinderConfigContext.tsx:20-26`).

### Service Worker Content Verification

When `verificationEnabled` is true, the app uses a service worker to verify Arweave content integrity:

**Architecture** (`src/service-worker/`):
- `service-worker.ts`: Main fetch interceptor that proxies `/ar-proxy/` requests and intercepts absolute paths for manifest-based apps
- `fetch-polyfill.ts`: Captures and binds native `self.fetch` before Zone.js (loaded by OpenTelemetry) can patch it and cause `Illegal invocation` errors; **must be the first import** in `service-worker.ts:17`
- `module-polyfill.ts`: Installs CommonJS `module`/`exports` shims on `globalThis` and `self` (`service-worker.ts:18`)
- `manifest-verifier.ts`: Orchestrates verification flow - resolves ArNS, fetches/verifies manifest, verifies all resources
- `verification-state.ts`: Tracks verification state, progress, and broadcasts events to the UI
- `verified-cache.ts`: LRU cache for verified content (100MB limit)
- `wayfinder-instance.ts`: Maintains Wayfinder client and `HashVerificationStrategy` / `SignatureVerificationStrategy` within service worker context
- `gateway-health.ts`: Service-worker-local gateway health cache (separate memory space from main thread)
- `location-patcher.ts`: Injects a `history.replaceState` script into proxied HTML responses so apps see `/` instead of `/ar-proxy/{identifier}/`
- `logger.ts`: Leveled service worker logger (`debug`, `info`, `warn`, `error`)
- `types.ts`: TypeScript interfaces for manifest structure, verification state, and events

**Security Model**:
- ArNS names are resolved via trusted gateways with consensus checking
- **Manifest content is cryptographically verified BEFORE trusting path→txId mappings**
  - Fetches raw content from routing gateway
  - Computes SHA-256 hash locally (or delegates to SDK `HashVerificationStrategy` / `SignatureVerificationStrategy`)
  - Verifies against trusted gateway (tries one at a time until success)
  - Only parses manifest JSON after verification passes
- All individual resources are verified against trusted gateways before serving
- Single files (non-manifests) are verified the same way but don't have sub-resources

**Dual Gateway Pools** (`src/utils/trustedGateways.ts`):
- `getTrustedGateways(count)` (`src/utils/trustedGateways.ts:30-82`): Configurable number of gateways by total stake (operator + delegated) for verification
  - Default count is 3, configurable via settings (1-10 range)
  - Fetches top 10 by stake, caches them for 24 hours (`wayfinder-trusted-gateways-v2`), then randomly selects `count` from that pool
  - Uses `@ar.io/sdk` via `getArioClient()` (`src/utils/trustedGateways.ts:6-12`) to query AR.IO network
- `getTopStakedGateways()` (`src/utils/trustedGateways.ts:88-103`): Returns the full cached pool of top 10 gateways (for settings display)
- `getRoutingGateways()` (`src/utils/trustedGateways.ts:242-299`): Broader pool from AR.IO gateway APIs for content fetching
  - Tries `turbo-gateway.com/ar-io/peers`, then `permagate.io/ar-io/peers`
  - Falls back to AR.IO SDK (`getArioClient()`) if both endpoints fail
  - Randomly selects 20 gateways from available peers, shuffled on each verification for load distribution

**Verification Flow**:
1. App proactively registers the service worker at startup (`src/main.tsx:11-17`) via `swMessenger.registerProactive()` so it is already controlling the page
2. When `verificationEnabled` is true, `AppContent` fetches trusted gateways and routing gateways (`src/App.tsx:280-328`) and sends `INIT_WAYFINDER` via `swMessenger.initializeWayfinder()`
3. User searches → iframe loads `/ar-proxy/{arns-or-txid}/`
4. Service worker intercepts (waiting up to 10s if initialization is still in flight):
   - Resolves ArNS name to txId via trusted gateways (consensus)
   - Selects a responsive routing gateway (HEAD request)
   - Fetches raw content, verifies against trusted gateway (`hash` by default; `SHOW_VERIFICATION_METHOD_SELECTOR` in `src/components/SettingsFlyout.tsx:10` is currently `false` pending SDK ANS-104 data item support)
   - For manifests: parses paths, verifies all resources in parallel (`verificationConcurrency`)
   - For single files: marks as verified immediately
5. Verified content served from cache (`location-patcher.ts` patches HTML responses)
6. For manifest-based apps with absolute paths (e.g., `/assets/foo.js`):
   - Service worker tracks "active identifier"
   - Intercepts non-navigate requests matching manifest paths
   - Does NOT intercept for single-file content (`isSingleFile` flag)

**State Tracking** (`src/service-worker/verification-state.ts`):
- `ManifestVerificationState`: Tracks identifier, manifestTxId, status, progress, `pathToTxId` map
- `isSingleFile` flag: Distinguishes single files from manifests (affects absolute path interception)
- `activeIdentifier`: Tracks which content is currently being served (for absolute path interception)
- Events broadcast to UI: `verification-started`, `routing-gateway`, `manifest-loaded`, `verification-progress`, `verification-complete`, `verification-failed`

**UI Components**:
- `VerificationLoadingScreen`: Full-screen loading overlay shown during verification (displays phase indicators, progress bar, recently verified resources, gateway, and elapsed time)
- `VerificationBadge`: Compact badge in `SearchBar` toolbar showing verification status after completion
- `VerificationBlockedModal`: Modal shown when strict mode blocks failed/partial verification

**Service Worker Registration**:
- Uses `vite-plugin-pwa` with `injectManifest` strategy (`vite.config.ts:20-40`, `rollupFormat: 'iife'`)
- Development: `/dev-sw.js?dev-sw` (module type)
- Production: `/service-worker.js`
- Registered proactively at startup in `src/main.tsx:11-17` — no page reload is required when toggling verification in `SettingsFlyout` (`src/components/SettingsFlyout.tsx:72-75`)

**Messaging** (`src/utils/serviceWorkerMessaging.ts`):
- `swMessenger.registerProactive(url, options)` (`lines 19-58`): Proactive startup registration and controller acquisition (`swMessenger.register()` at `lines 125-127` is a deprecated alias)
- `swMessenger.initializeWayfinder(config)` (`lines 182-196`): Send config (`INIT_WAYFINDER`) to service worker
- `swMessenger.clearCache()` (`lines 201-205`): Clear all caches in service worker
- `swMessenger.clearVerification(identifier)` (`lines 211-216`): Clear verification state for a specific identifier

## Design System

The app uses the AR.IO Wayfinder extension design system, which matches the Figma design tokens exactly. The design system is implemented through both Tailwind CSS classes and CSS custom properties.

### Color System

Colors are defined in tailwind.config.js and as CSS custom properties in index.css:

**Containers** (backgrounds, layers):
- `container-L0`: #050505 (deep black)
- `container-L1`: #0e0e0f (main background)
- `container-L2`: #1c1c1f (cards, elevated surfaces)
- `container-L3`: #2a2a2e (highly elevated elements)

**Text**:
- `text-high`: #cacad6 (high contrast, primary text)
- `text-low`: #7f7f87 (low contrast, secondary text)
- `text-white`: #ffffff (pure white)

**Icons**:
- `icon-high`: #cacad6 (high contrast icons)
- `icon-mid`: #a3a3ad (medium contrast icons)
- `icon-low`: #7f7f87 (low contrast icons)

**Accents**:
- Teal Primary: #2dd3be (primary actions, brand color)
- Teal Secondary: #0d9085 (hover states)
- Teal Tertiary: #bc123c (red accent)
- Blue: #0055fe (blue accent)
- Blue Light: #6a82fc (light blue variant)

**Strokes/Borders**:
- `stroke-low`: rgba(202, 202, 214, 0.08) (subtle borders)
- `stroke-high`: rgba(202, 202, 214, 0.32) (emphasis borders)
- `border-default`: rgba(255, 255, 255, 0.2)

**Semantic Colors**:
- Success: rgba(211, 255, 202, 0.8) / #22c55e
- Warning: #fcb823 / #f59e0b
- Error: #f23f5d / #ef4444
- Info: #6a82fc / #3b82f6

**Gradients**:
- Primary gradient: `linear-gradient(135deg, #f7c3a1, #df9be8)` (peach to purple)
- Teal gradient: `linear-gradient(135deg, #2dd3be, #0d9085)`
- Available as Tailwind classes: `bg-gradient-primary`, `bg-gradient-teal`

### Typography System

**Font Families**:
- Primary: Rubik (loaded from Google Fonts in index.html)
- Secondary: Inter
- Monospace: JetBrains Mono
- Headings use `font-rubik` or `font-sans`

**Font Sizes** (extension system):
- Display: 60px / line-height 1.2 / weight 700
- H1-H6: 50px, 42px, 35px, 29px, 24px, 17px
- Paragraphs: 24px (xxlarge), 20px (xlarge), 17px (large), 14px (normal), 12px (small)
- Caption: 11px / weight 400 or 700

**Usage in Tailwind**:
- Use semantic sizes: `text-h1`, `text-p-normal`, `text-caption-bold`
- Or standard scale: `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`, `text-2xl`

### Spacing System

Extension spacing scale (in tailwind.config.js):
- `spacing-xs`: 4px
- `spacing-sm`: 8px
- `spacing-md`: 16px
- `spacing-lg`: 24px
- `spacing-xl`: 32px
- `spacing-2xl`: 48px

Use in Tailwind as: `p-md`, `m-lg`, `gap-sm`, etc.

### Shadows

**Card Shadow** (Figma design):
```css
--shadow-card: 0px 1726px 483px rgba(0,0,0,0.01),
               0px 1105px 442px rgba(0,0,0,0.04),
               0px 621px 373px rgba(0,0,0,0.15),
               0px 276px 276px rgba(0,0,0,0.26),
               0px 69px 152px rgba(0,0,0,0.29);
```

**Standard Shadows**:
- `shadow-sm`: 0 1px 2px rgba(0, 0, 0, 0.3)
- `shadow-md`: 0 4px 6px -1px rgba(0, 0, 0, 0.4)
- `shadow-lg`: 0 10px 15px -3px rgba(0, 0, 0, 0.5)

### Border Radius

- `rounded-sm`: 4px
- `rounded-md`: 8px
- `rounded-lg`: 12px
- `rounded-xl`: 16px

### Transitions

CSS custom properties for transitions:
- `--transition-fast`: 0.2s ease
- `--transition-base`: 0.3s ease
- `--transition-slow`: 0.4s ease

Tailwind easing: `ease-smooth` (cubic-bezier(0.4, 0, 0.2, 1))

### Utility Classes

**Scrollbar Styling**:
- `.scrollbar-styled` - Custom scrollbar matching extension design
- `.scrollbar-hide` - Hide scrollbar but keep scrollability

**Animations**:
- `.icon-spin` - Spinning animation for loading icons
- `.animate-slide-in` - Slide in from bottom animation
- `.animate-pulse` - Pulsing animation

**Gradient Borders**:
- `.gradient-border` - Adds gradient border using the primary gradient

**Inline Icons**:
- `.inline-icon` - Properly aligned inline icons

### Best Practices

1. **Use Tailwind classes** for component styling: `bg-container-L1`, `text-text-high`, `border-stroke-low`
2. **Use CSS custom properties** when you need dynamic values or JavaScript access: `var(--colors-container-containerL1)`
3. **Typography**: Prefer semantic sizes (`text-p-normal`) over arbitrary values
4. **Spacing**: Use the extension spacing scale (`gap-md`, `p-lg`) for consistency
5. **Shadows**: Use `shadow-card` for elevated cards matching the extension design
6. **Gradients**: Use `bg-gradient-primary` for accent elements, borders use `.gradient-border` utility class

## Build Configuration

### Node.js Polyfills Architecture

Browser compatibility for Arweave/Solana/Wayfinder dependencies is handled uniformly in both development and production via `vite-plugin-node-polyfills` (`vite.config.ts:6-40`):

1. **Main Application Build** (`vite.config.ts:19`):
   - `nodePolyfills(nodePolyfillsConfig)` injects browser shims for Node.js built-ins (including `util`, `crypto`, `stream`, `events`, and `node:` protocol imports via `protocolImports: true`) and module-scoped `Buffer`, `global`, and `process` globals (`vite.config.ts:6-13`).
   - Enabled uniformly across `vite dev` and `vite build` to maintain dev/production parity.

2. **Service Worker Sub-Build** (`vite.config.ts:20-40` and `src/service-worker/service-worker.ts:17-18`):
   - `VitePWA` (`injectManifest` with `rollupFormat: 'iife'`) drops root plugins during its secondary Vite build, so it explicitly configures a **separate** `nodePolyfills(nodePolyfillsConfig)` instance under `injectManifest.buildPlugins.vite` (`vite.config.ts:30-32`). Do not share the same plugin instance across both builds.
   - `src/service-worker/fetch-polyfill.ts` must remain the first import (`service-worker.ts:17`) so native `self.fetch` is bound before Zone.js (pulled in by OpenTelemetry) patches it.
   - `src/service-worker/module-polyfill.ts` (`service-worker.ts:18`) provides `module` and `exports` shims on `globalThis`/`self` for CommonJS dependencies.

3. **CommonJS Interop** (`vite.config.ts:42-49`):
   - `build.commonjsOptions` enables `transformMixedEsModules: true` and `requireReturnsDefault: 'auto'`.

## iframe Security Configuration

The `ContentViewer` (`src/components/ContentViewer.tsx:150-193`) detects PDFs and uses an `<object>` tag instead of an iframe for better compatibility. For non-PDF content, the iframe uses these sandbox attributes:
- `allow-scripts` - Required for interactive content
- `allow-same-origin` - Required for certain content types
- `allow-forms` - Allows form submissions
- `allow-popups` - Allows opening new windows
- `allow-popups-to-escape-sandbox` - Required for some navigation

The verification-mode iframe (`src/App.tsx:639-649`) uses the same sandbox attributes for displaying verified content.

PDFs are rendered using `<object type="application/pdf">` which avoids sandbox restrictions and uses the browser's native PDF viewer without triggering downloads.

## Common Patterns

### Adding a New Routing Strategy

1. Add type to `RoutingStrategy` union in `src/types/index.ts:1`
2. Add option to `ROUTING_STRATEGY_OPTIONS` in `src/utils/constants.ts:24`
3. Update `SettingsFlyout.tsx` to handle new strategy UI if needed
4. Update strategy mapping in `src/App.tsx:164-188` and `src/service-worker/wayfinder-instance.ts:126-144` if needed

### Modifying Configuration Schema

1. Update `WayfinderConfig` interface in `src/types/index.ts:5`
2. Update `DEFAULT_CONFIG` in `src/utils/constants.ts:14`
3. Update `wayfinderConfig` construction in `src/App.tsx:40` (and `SwWayfinderConfig` / `swMessenger.initializeWayfinder` if relevant to verification)
4. Update `SettingsFlyout.tsx` UI to expose new setting

### Adding Service Worker Message Types

1. Add message type handler in `src/service-worker/service-worker.ts:62` (message event listener)
2. Add corresponding method in `src/utils/serviceWorkerMessaging.ts`
3. Update `src/service-worker/types.ts` if new types are needed

### Error Handling Pattern

All components using Wayfinder hooks (like `ContentViewer`) receive `{ resolvedUrl, isLoading, error }`. Always check states in order:
1. Check `isLoading` (and `isCheckingHealth`) → show `RoutingLoadingScreen`
2. Check `error` → show `ErrorDisplay` with retry handler
3. Check `resolvedUrl` validity (and `healthCheckPassed`) → show content or fallback

## Troubleshooting

**"No gateways available" error**: The `WayfinderProvider` requires `routingSettings.strategy` to be configured. Check `src/App.tsx:72-204` to ensure:
- `TrustedPeersGatewaysProvider` is initialized with valid AR.IO gateway URLs (`turbo-gateway.com`, `permagate.io`)
- AR.IO SDK fallback (`getArioClient()`) is working (check console for SDK error messages)
- `createRoutingStrategy` is called with `gatewaysProvider`
- `routingSettings.strategy` is passed to `WayfinderProvider`

**Gateway API endpoints failing**: If both `turbo-gateway.com` and `permagate.io` `/ar-io/peers` endpoints are down:
- Check console logs to see which fallback tier is being used
- AR.IO SDK (`getArioClient()`) should provide automatic fallback to network contract
- Verify network connection and that AR.IO network is accessible

**Build errors about missing modules**:
- If using local Wayfinder packages, rebuild them: `cd ../wayfinder && npm run build`
- Clear Vite cache: `rm -rf node_modules/.vite`
- Reinstall dependencies: `npm install`

**Content doesn't load**:
- Check browser console for CSP errors - some Arweave content may block iframe embedding
- Try the "Retry with different gateway" button to use an alternative gateway
- Verify the ArNS name or transaction ID is correct

**Settings not persisting**: Check browser localStorage isn't disabled/full. Clear localStorage key `wayfinder-app-config` and reload to reset to defaults.

**Type errors after dependency updates**: Ensure `@ar.io/wayfinder-react` and `@ar.io/wayfinder-core` versions are compatible and both properly built.

**Crypto/Buffer/Node builtin errors**: If you see errors about missing `Buffer`, `process`, `global`, `util`, or `exports`:
- Verify `vite-plugin-node-polyfills` is installed in `devDependencies` and configured in `vite.config.ts:6-19`
- Verify `injectManifest.buildPlugins.vite` in `vite.config.ts:30-32` receives its own `nodePolyfills(nodePolyfillsConfig)` instance for the service worker build
- Avoid adding manual `define: { global: 'globalThis' }` or `'process.browser': 'true'`, which conflict with `vite-plugin-node-polyfills` shims and Rollup CommonJS transforms
- Ensure `src/service-worker/fetch-polyfill.ts` remains the very first import in `src/service-worker/service-worker.ts:17` if you see `Illegal invocation` errors on `fetch`

**Service worker not working**:
- Check browser DevTools > Application > Service Workers for registration status
- Proactive registration happens at startup in `src/main.tsx:11-17`; if controller isn't active yet, reload once
- In development, `vite-plugin-pwa` serves `/dev-sw.js?dev-sw`; in production it's `/service-worker.js`
- Clear service worker and reload: DevTools > Application > Service Workers > Unregister
- Check console for `[SW]` prefixed log messages for debugging

**Verification shows "not controlling page"**: The service worker must control the page to intercept `/ar-proxy/` requests. Proactive registration handles this at startup (`src/main.tsx:11-17`); if it hasn't taken control yet, reload the page once.
