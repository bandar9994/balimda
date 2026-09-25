# Balimda — © 2026 Bandar. All rights reserved.
# Licensed under the Balimda License (see LICENSE): non-commercial use only;
# keep the Balimda name and the "Balimda by Bandar" credit; no rebranding.

# Native llama.cpp engine for Balimda on Android: CPU (ARM NEON/dotprod) plus
# the OpenCL backend that Qualcomm tunes for Adreno GPUs.
cmake_minimum_required(VERSION 3.22)
project(balimda_llama C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

include(FetchContent)
if (POLICY CMP0169)
    cmake_policy(SET CMP0169 OLD)  # allow FetchContent_Populate with EXCLUDE_FROM_ALL subdirectories
endif ()

set(LLAMA_CPP_TAG b11170 CACHE STRING "llama.cpp release to build")
option(BALIMDA_OPENCL "Build the OpenCL (Adreno GPU) backend" ON)

# ---- OpenCL -----------------------------------------------------------------
# We compile against the official Khronos headers and link against a stub
# libOpenCL.so generated from them. The stub is NOT packaged into the APK: at
# runtime the phone's own driver (/vendor/lib64/libOpenCL.so) is used, which
# the manifest makes visible with <uses-native-library>.
if (BALIMDA_OPENCL)
    if (DEFINED OPENCL_HEADERS_DIR)
        set(CL_HEADERS_DIR ${OPENCL_HEADERS_DIR})
    else ()
        FetchContent_Declare(opencl_headers
            URL https://github.com/KhronosGroup/OpenCL-Headers/archive/refs/tags/v2024.10.24.tar.gz)
        FetchContent_GetProperties(opencl_headers)
        if (NOT opencl_headers_POPULATED)
            FetchContent_Populate(opencl_headers)
        endif ()
        set(CL_HEADERS_DIR ${opencl_headers_SOURCE_DIR})
    endif ()

    file(STRINGS ${CL_HEADERS_DIR}/CL/cl.h cl_lines REGEX "^cl[A-Za-z0-9_]+\\(")
    set(stub_src "// Generated link-time stub; the real driver is loaded at runtime.\n")
    set(stub_names "")
    foreach (line IN LISTS cl_lines)
        string(REGEX MATCH "^cl[A-Za-z0-9_]+" fn "${line}")
        list(APPEND stub_names ${fn})
    endforeach ()
    list(REMOVE_DUPLICATES stub_names)
    foreach (fn IN LISTS stub_names)
        string(APPEND stub_src "void ${fn}(void) {}\n")
    endforeach ()
    file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/opencl_stub.c "${stub_src}")
    add_library(OpenCL SHARED ${CMAKE_CURRENT_BINARY_DIR}/opencl_stub.c)
    set_target_properties(OpenCL PROPERTIES OUTPUT_NAME OpenCL
        LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/opencl_stub)

    # Satisfy ggml's find_package(OpenCL) with the headers and the stub target.
    set(OpenCL_INCLUDE_DIR ${CL_HEADERS_DIR} CACHE PATH "" FORCE)
    set(OpenCL_LIBRARY OpenCL CACHE STRING "" FORCE)
    set(GGML_OPENCL ON CACHE BOOL "" FORCE)
    set(GGML_OPENCL_EMBED_KERNELS ON CACHE BOOL "" FORCE)
    set(GGML_OPENCL_USE_ADRENO_KERNELS ON CACHE BOOL "" FORCE)
endif ()

# ---- llama.cpp ----------------------------------------------------------------
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE ON CACHE BOOL "" FORCE)
if (ANDROID)
    # Every Snapdragon since the 855 (2019) has dot-product instructions; the
    # app checks for them at runtime before loading this library.
    set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod+fp16" CACHE STRING "" FORCE)
endif ()

if (DEFINED LLAMA_CPP_SOURCE_DIR)
    set(llama_src ${LLAMA_CPP_SOURCE_DIR})
else ()
    FetchContent_Declare(llama_cpp
        URL https://github.com/ggml-org/llama.cpp/archive/refs/tags/${LLAMA_CPP_TAG}.tar.gz)
    FetchContent_GetProperties(llama_cpp)
    if (NOT llama_cpp_POPULATED)
        FetchContent_Populate(llama_cpp)
    endif ()
    set(llama_src ${llama_cpp_SOURCE_DIR})
endif ()
add_subdirectory(${llama_src} ${CMAKE_CURRENT_BINARY_DIR}/llama.cpp EXCLUDE_FROM_ALL)

# ---- JNI library ----------------------------------------------------------------
add_library(balimda_llama SHARED balimda_llama.cpp)
target_link_libraries(balimda_llama PRIVATE llama ggml)
if (ANDROID)
    target_link_libraries(balimda_llama PRIVATE log android)
    target_link_options(balimda_llama PRIVATE "-Wl,-z,max-page-size=16384")
else ()
    find_package(JNI REQUIRED)
    target_include_directories(balimda_llama PRIVATE ${JNI_INCLUDE_DIRS})
endif ()
