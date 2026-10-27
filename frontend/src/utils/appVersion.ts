// Isolated so modules that show the version can be loaded where `import.meta` is unavailable.
export const APP_VERSION = import.meta.env.PACKAGE_VERSION as string;
