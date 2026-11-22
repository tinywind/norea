# Android CI/release builder assembled from official Docker Hub images.
FROM node:24-bookworm AS node_toolchain
FROM eclipse-temurin:17-jdk-jammy AS jdk_toolchain
FROM rust:1-slim-bookworm

ARG PNPM_VERSION=10.27.0
ARG ANDROID_SDK_PLATFORM=android-36
ARG ANDROID_BUILD_TOOLS=36.0.0
ARG ANDROID_NDK_VERSION=29.0.14206865
ARG ANDROID_CMAKE_VERSION=3.22.1
ARG ANDROID_CMDLINE_TOOLS_ZIP=commandlinetools-linux-16111833_latest.zip
ARG ANDROID_CMDLINE_TOOLS_SHA1=e025545c62a8e64c7559119566a569fb1dec5f60

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      libssl-dev \
      libtinfo6 \
      libxml2 \
      ninja-build \
      pkg-config \
      unzip \
      zlib1g \
      zstd \
    && rm -rf /var/lib/apt/lists/*

# Copy Node.js 24 from official Docker Hub node image and install pinned pnpm.
COPY --from=node_toolchain /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/
COPY --from=node_toolchain /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN npm install --global --no-audit --no-fund "pnpm@${PNPM_VERSION}" \
    && test "$(pnpm --version)" = "${PNPM_VERSION}"

# Copy Temurin JDK 17 from official Docker Hub eclipse-temurin image.
COPY --from=jdk_toolchain /opt/java/openjdk /opt/java/openjdk

ENV JAVA_HOME=/opt/java/openjdk \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    NDK_HOME=/opt/android-sdk/ndk/${ANDROID_NDK_VERSION} \
    ANDROID_NDK_HOME=/opt/android-sdk/ndk/${ANDROID_NDK_VERSION} \
    CMAKE=/opt/android-sdk/cmake/${ANDROID_CMAKE_VERSION}/bin/cmake \
    LIBCLANG_PATH=/opt/android-sdk/ndk/${ANDROID_NDK_VERSION}/toolchains/llvm/prebuilt/linux-x86_64/lib \
    PATH="/opt/java/openjdk/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/${ANDROID_BUILD_TOOLS}:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

RUN rustup target add aarch64-linux-android x86_64-linux-android

RUN set -eux; \
    mkdir -p "${ANDROID_HOME}/cmdline-tools"; \
    curl -fsSL "https://dl.google.com/android/repository/${ANDROID_CMDLINE_TOOLS_ZIP}" -o /tmp/cmdline-tools.zip; \
    echo "${ANDROID_CMDLINE_TOOLS_SHA1}  /tmp/cmdline-tools.zip" | sha1sum -c -; \
    unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools-extract; \
    mv /tmp/cmdline-tools-extract/cmdline-tools "${ANDROID_HOME}/cmdline-tools/latest"; \
    rm -rf /tmp/cmdline-tools.zip /tmp/cmdline-tools-extract; \
    yes | "${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null || true; \
    test -d "${ANDROID_HOME}/licenses"; \
    "${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager" --install \
      "platform-tools" \
      "platforms;${ANDROID_SDK_PLATFORM}" \
      "build-tools;${ANDROID_BUILD_TOOLS}" \
      "ndk;${ANDROID_NDK_VERSION}" \
      "cmake;${ANDROID_CMAKE_VERSION}"; \
    test -x "${CMAKE}"; \
    "${CMAKE}" --version; \
    clang_bin="${NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/bin/clang"; \
    test -x "${clang_bin}"; \
    test -x "${clang_bin}++"; \
    test -f "${LIBCLANG_PATH}/libclang.so"; \
    test -d "${NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/sysroot"; \
    resource_dir="$("${clang_bin}" --print-resource-dir)"; \
    test -f "${resource_dir}/include/stddef.h"; \
    node --version; \
    pnpm --version; \
    java -version; \
    keytool -help >/dev/null; \
    rustc --version; \
    cargo --version; \
    chmod -R a+rX "${ANDROID_HOME}" "${JAVA_HOME}" /usr/local/rustup /usr/local/cargo
