interface JevYouTubeGuardPolicy {
  isTargetPage(url: string): boolean;
  shouldBlock(result: { category?: string; confidence?: number }): boolean;
}

declare global {
  var JevYouTubeGuardPolicy: JevYouTubeGuardPolicy;
}

export {};
