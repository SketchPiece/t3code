# Helm fork: an in-app Tailscale node for reaching Helm machines on the tailnet.
libtailscale = File.join(__dir__, 'libtailscale', 'Libtailscale.xcframework')
unless File.exist?(libtailscale)
  system(File.join(__dir__, '..', 'scripts', 'build-libtailscale.sh')) or
    raise 'helm-tailscale: building libtailscale failed (see scripts/build-libtailscale.sh)'
end

Pod::Spec.new do |s|
  s.name           = 'HelmTailscale'
  s.version        = '1.0.0'
  s.summary        = 'In-app Tailscale node for Helm mobile.'
  s.description    = 'Joins the user tailnet with tsnet and tunnels loopback ports to tailnet hosts.'
  s.author         = 'Helm'
  s.homepage       = 'https://github.com/SketchPiece/t3code'
  s.license        = { :type => 'BSD-3-Clause', :file => 'libtailscale/LICENSE' }
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '*.swift', 'libtailscale/tailscale.h'
  s.public_header_files = 'libtailscale/tailscale.h'
  s.vendored_frameworks = 'libtailscale/Libtailscale.xcframework'
  s.frameworks = 'CoreFoundation', 'Security', 'SystemConfiguration'
  s.libraries = 'resolv'
end
