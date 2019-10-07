import net.sf.json.JSONArray
import net.sf.json.JSONObject

library 'node1016-jenkins-library'

project = "poet"
projectShort = "poet"
greyColor = '#D4DADF'

@NonCPS def uniqueBy(List items, String key) {
  return items.unique { a,b -> a[key] <=> b[key]}
}

def volumes = [
  node1016BuilderPersistentVolumes(
    project: "${project}"
  )
].flatten()

def volumeClaims = uniqueBy(volumes, 'path').collect { volume ->
  persistentVolumeClaim(
    claimName: volume.claimName,
    mountPath: volume.path
  )
}

def containers = [
  [containerTemplate(
    name: 'jnlp',
    image: 'openshift/jenkins-slave-base-centos7:v3.7',
    args: '${computer.jnlpmac} ${computer.name}'
  )],
  node1016BuilderContainerTemplate(),
].flatten()

def buildNumber = env.BUILD_NUMBER;

podTemplate(label: "${project}-deploy-pod-build-pod", cloud: 'openshift', containers: containers, volumes: volumeClaims) {
  node("${project}-deploy-pod-build-pod") {

    final builds = [:]
    final buildStage = (env.BRANCH_NAME == 'master' || env.BRANCH_NAME == 'develop') ? 'dist' : 'test'
    final environment = env.BRANCH_NAME
    def gitCommitHash = "unknown"

    builds["Build Client Components"] = {
      buildNode1016Component(
        baseDir: "./",
        project: "${project}",
        component: "pds-client",
        buildNumber: buildNumber,
        stage: buildStage,
        environment: environment
      )
    }

    try {

      stage('Checkout code') {
        def scmVars = checkout scm
        gitCommitHash = scmVars.GIT_COMMIT
      }

      container('node1016-builder') {

        stage('Install') {
          sh "npm install"
        }

        stage('test serverless config') {
          configFileProvider([configFile(fileId: 'env-config-settings', targetLocation: 'local.yml')]) {
            sh "npm run sls -- deploy --noDeploy --stage dev"
          }
        }
      }

    } catch (InterruptedException e) {
      // Build interupted
      currentBuild.result = "ABORTED"
      throw e
    } catch (e) {
      // If there was an exception thrown, the build failed
      currentBuild.result = "FAILED"
      throw e
    } finally {
      // Success or failure, always send notifications
    //   notifySlack(currentBuild.result)
    }
  }
}
