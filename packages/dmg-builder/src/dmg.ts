import { DmgOptions, Target } from "app-builder-lib"
import { findIdentity, isSignAllowed } from "app-builder-lib/out/codeSign/macCodeSign"
import MacPackager from "app-builder-lib/out/macPackager"
import { createBlockmap } from "app-builder-lib/out/targets/differentialUpdateInfoBuilder"
import { sanitizeFileName } from "app-builder-lib/out/util/filename"
import { Arch, exec, getArchSuffix, InvalidConfigurationError, isEmptyOrSpaces } from "builder-util"
import * as path from "path"

import { computeBackground, getDmgVendorPath } from "./dmgUtil"

export class DmgTarget extends Target {
  readonly options: DmgOptions = this.packager.config.dmg || Object.create(null)

  constructor(private readonly packager: MacPackager, readonly outDir: string) {
    super("dmg")
  }

  async build(appPath: string, arch: Arch) {
    const packager = this.packager
    // tslint:disable-next-line:no-invalid-template-strings
    const artifactName = packager.expandArtifactNamePattern(
      this.options,
      "dmg",
      arch,
      "${productName}-" + (packager.platformSpecificBuildOptions.bundleShortVersion || "${version}") + "-${arch}.${ext}",
      true,
      packager.platformSpecificBuildOptions.defaultArch
    )
    const artifactPath = path.join(this.outDir, artifactName)
    await packager.info.callArtifactBuildStarted({
      targetPresentableName: "DMG",
      file: artifactPath,
      arch,
    })

    const volumeName = sanitizeFileName(this.computeVolumeName(arch, this.options.title))

    await exec(
      process.env.PYTHON_PATH || "/usr/bin/python3",
      ["-m", "dmgbuild", `-s ${path.join(getDmgVendorPath(), "../templates/settings.py")}`, `-D app=${appPath}`, `${volumeName}`, `${artifactPath}`],
      {
        cwd: getDmgVendorPath(),
        env: { ...process.env, LC_ALL: "C.UTF-8" },
      }
    )

    if (this.options.sign === true) {
      await this.signDmg(artifactPath)
    }

    const safeArtifactName = packager.computeSafeArtifactName(artifactName, "dmg")
    const updateInfo = this.options.writeUpdateInfo === false ? null : await createBlockmap(artifactPath, this, packager, safeArtifactName)
    await packager.info.callArtifactBuildCompleted({
      file: artifactPath,
      safeArtifactName,
      target: this,
      arch,
      packager,
      isWriteUpdateInfo: updateInfo != null,
      updateInfo,
    })
  }

  private async signDmg(artifactPath: string) {
    if (!isSignAllowed(false)) {
      return
    }

    const packager = this.packager
    const qualifier = packager.platformSpecificBuildOptions.identity
    // explicitly disabled if set to null
    if (qualifier === null) {
      // macPackager already somehow handle this situation, so, here just return
      return
    }

    const keychainFile = (await packager.codeSigningInfo.value).keychainFile
    const certificateType = "Developer ID Application"
    let identity = await findIdentity(certificateType, qualifier, keychainFile)
    if (identity == null) {
      identity = await findIdentity("Mac Developer", qualifier, keychainFile)
      if (identity == null) {
        return
      }
    }

    const args = ["--sign", identity.hash]
    if (keychainFile != null) {
      args.push("--keychain", keychainFile)
    }
    args.push(artifactPath)
    await exec("codesign", args)
  }

  computeVolumeName(arch: Arch, custom?: string | null): string {
    const appInfo = this.packager.appInfo
    const shortVersion = this.packager.platformSpecificBuildOptions.bundleShortVersion || appInfo.version
    const archString = getArchSuffix(arch, this.packager.platformSpecificBuildOptions.defaultArch)

    if (custom == null) {
      return `${appInfo.productFilename} ${shortVersion}${archString}`
    }

    return custom
      .replace(/\${arch}/g, archString)
      .replace(/\${shortVersion}/g, shortVersion)
      .replace(/\${version}/g, appInfo.version)
      .replace(/\${name}/g, appInfo.name)
      .replace(/\${productName}/g, appInfo.productName)
  }

  // public to test
  async computeDmgOptions(): Promise<DmgOptions> {
    const packager = this.packager
    const specification: DmgOptions = { ...this.options }
    if (specification.icon == null && specification.icon !== null) {
      specification.icon = await packager.getIconPath()
    }

    if (specification.icon != null && isEmptyOrSpaces(specification.icon)) {
      throw new InvalidConfigurationError("dmg.icon cannot be specified as empty string")
    }

    const background = specification.background
    if (specification.backgroundColor != null) {
      if (background != null) {
        throw new InvalidConfigurationError("Both dmg.backgroundColor and dmg.background are specified — please set the only one")
      }
    } else if (background == null) {
      specification.background = await computeBackground(packager)
    } else {
      specification.background = path.resolve(packager.info.projectDir, background)
    }

    if (specification.format == null) {
      if (process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL != null) {
        ;(specification as any).format = "UDZO"
      } else if (packager.compression === "store") {
        specification.format = "UDRO"
      } else {
        specification.format = packager.compression === "maximum" ? "UDBZ" : "UDZO"
      }
    }

    if (specification.contents == null) {
      specification.contents = [
        {
          x: 130,
          y: 220,
        },
        {
          x: 410,
          y: 220,
          type: "link",
          path: "/Applications",
        },
      ]
    }
    return specification
  }
}
