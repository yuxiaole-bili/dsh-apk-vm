# dsh-apk-vm sample APK

A 12 KB, one-Activity Android app used by the reproducible demo. It uses only
framework classes (no AndroidX, no Kotlin, no Gradle) and is licensed under MIT
(see [`LICENSE`](LICENSE)).

- Package: `dev.dsh.sample`
- Min SDK: 24
- Target SDK: 34
- Launcher Activity: `dev.dsh.sample.MainActivity`
- Start screen: `dsh-apk-vm sample` and the text
  `Tap the button to greet the VM.`
- After tapping **Say hello**: the status text becomes exactly
  `Hello from dsh-apk-vm`

## Build

From the repository root:

```powershell
$env:ANDROID_SDK_ROOT = 'C:\Android\sdk'
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-17'
node examples/sample-apk/build.mjs
```

The script only needs `aapt2`, `zipalign`, `d8.jar`, `apksigner.jar`, a JDK
(`java`, `javac`, `jar`, `keytool`) and `platforms/android-34/android.jar`.
It writes `dsh-sample.apk` and prints the SHA-256. See
[`../README.md`](../README.md) for prerequisites, expected output and the
reproducibility details.

## Signing

`demo-public.keystore` is a public, throwaway test key (PKCS#12, alias
`dsh-sample`, store/key pass `android`). It is intentionally checked in so the
committed APK can be rebuilt byte-for-byte. **Do not use it to sign a real app.**
The build uses APK Signature Scheme v2/v3 and disables v1 JAR signing to keep
the output deterministic.

## Files

| Path | Purpose |
| --- | --- |
| `src/dev/dsh/sample/MainActivity.java` | Activity: wires the button to the status text. |
| `res/layout/activity_main.xml` | Centered heading, status `TextView`, button. |
| `res/values/strings.xml` | All user-visible strings, including the asserted result. |
| `res/values/styles.xml` | Framework Material theme; no appcompat dependency. |
| `AndroidManifest.xml` | Single exported launcher Activity. |
| `build.mjs` | Reproducible SDK-only build. |
| `dsh-sample.apk` | Signed output checked in for demo users without an SDK. |
| `demo-public.keystore` | Public demo signing key. |
