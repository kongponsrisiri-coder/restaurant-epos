cmake_minimum_required(VERSION 3.4.1)

# node-host: builds the JNI bridge that starts the prebuilt nodejs-mobile
# libnode.so. Bridge sources are taken verbatim from nodejs-mobile-react-native
# (native-lib.cpp + rn-bridge.cpp) so the JNI symbol names still match the
# Java class com.janeasystems.rn_nodejs_mobile.RNNodeJsMobileModule.

add_library( nodejs-mobile-react-native-native-lib
             SHARED
             src/main/cpp/native-lib.cpp
             src/main/cpp/rn-bridge.cpp
             src/main/cpp/crash_handler.cpp )

include_directories(libnode/include/node/)
include_directories(src/main/cpp/)

add_library( libnode SHARED IMPORTED )
set_target_properties( libnode
                       PROPERTIES IMPORTED_LOCATION
                       ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so )

find_library( log-lib log )

# crash_handler.cpp uses dladdr() from libdl for best-effort symbolisation.
find_library( dl-lib dl )

target_link_libraries( nodejs-mobile-react-native-native-lib
                       libnode
                       ${log-lib}
                       ${dl-lib} )
