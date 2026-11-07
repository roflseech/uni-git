/**
 * Public half of the release signing key (tools/release/keygen.mjs). The updater installs only releases whose
 * latest.json is signed with the private half, which lives in the GitHub secret UNI_GIT_SIGNING_KEY.
 */
export const UPDATE_PUBLIC_KEY = "MCowBQYDK2VwAyEAOMW761WpgW8e6W726HM6QCktKc9IgSscToqIYf0GlVM=";
