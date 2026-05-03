Pod::Spec.new do |s|
  s.name           = 'HermesLiveActivityBridge'
  s.version        = '1.0.0'
  s.summary        = 'Bridge for Hermes ActivityKit live activities'
  s.description    = 'Local Expo module exposing ActivityKit start/update/end ' \
                     'so the JS side can drive iOS 16.2+ Live Activities for ' \
                     'in-flight chat runs and pending approvals.'
  s.author         = { 'Hermes' => 'noreply@hermesapp.local' }
  s.homepage       = 'https://github.com/hermesapp/hermes-mobile'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '16.2' }
  s.source         = { :git => 'https://github.com/hermesapp/hermes-mobile.git', :tag => "v#{s.version}" }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.swift_version  = '5.4'
  s.source_files = 'ios/**/*.{h,m,swift}'
end
