export type ToolName = 'ffmpeg' | 'ffprobe'
export interface BinaryAsset {
  id: number
  bytes: number
  sha256: string
}

export const binaryRelease = 'b6.1.1'
export const binarySource = `https://github.com/eugeneware/ffmpeg-static/releases/download/${binaryRelease}`

// Pinned from the upstream GitHub release API, including the compressed asset digest.
// Both download entry points must produce these exact bytes before anything is executed.
const assets: Record<string, BinaryAsset> = {
  'ffmpeg-linux-x64': {
    id: 316528626,
    bytes: 29354986,
    sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
  },
  'ffprobe-linux-x64': {
    id: 316529539,
    bytes: 29276839,
    sha256: '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067',
  },
  'ffmpeg-linux-arm64': {
    id: 316528458,
    bytes: 25568691,
    sha256: '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
  },
  'ffprobe-linux-arm64': {
    id: 316529229,
    bytes: 25493573,
    sha256: '2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8',
  },
  'ffmpeg-win32-x64': {
    id: 316528798,
    bytes: 29581307,
    sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
  },
  'ffprobe-win32-x64': {
    id: 316529830,
    bytes: 29521644,
    sha256: 'f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d',
  },
  'ffmpeg-darwin-x64': {
    id: 316528367,
    bytes: 25296431,
    sha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  },
  'ffprobe-darwin-x64': {
    id: 316528994,
    bytes: 25239438,
    sha256: 'd4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186',
  },
  'ffmpeg-darwin-arm64': {
    id: 316528311,
    bytes: 19246198,
    sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
  },
  'ffprobe-darwin-arm64': {
    id: 316528892,
    bytes: 19207077,
    sha256: 'd986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be',
  },
}

export function binaryAsset(name: ToolName, platform: string): BinaryAsset | undefined {
  return assets[`${name}-${platform}`]
}
