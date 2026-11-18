# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# What of ITK the tools are built on, by name. The build compares this with
# what ITK says it was built with (ors_check_itk_modules), and stops when
# the two differ: a library that came in unnoticed has a licence nobody
# looked at. THIRD-PARTY.md is written from the first list.

# Libraries of others that ITK carries inside it.
set(ORS_ITK_THIRD_PARTY
  ITKDoubleConversion
  ITKEigen3
  ITKExpat
  ITKGDCM
  ITKGIFTI
  ITKJPEG
  ITKKWSys
  ITKMetaIO
  ITKNIFTI
  ITKNetlib
  ITKNrrdIO
  ITKPNG
  ITKTIFF
  ITKVNL
  ITKVNLInstantiation
  ITKZLIB
)

# ITK's own modules.
set(ORS_ITK_OWN
  ITKBinaryMathematicalMorphology
  ITKCommon
  ITKConnectedComponents
  ITKConvolution
  ITKCurvatureFlow
  ITKDisplacementField
  ITKDistanceMap
  ITKFFT
  ITKFiniteDifference
  ITKIOBMP
  ITKIOGDCM
  ITKIOGIPL
  ITKIOImageBase
  ITKIOJPEG
  ITKIOMeshBYU
  ITKIOMeshBase
  ITKIOMeshFreeSurfer
  ITKIOMeshGifti
  ITKIOMeshOBJ
  ITKIOMeshOFF
  ITKIOMeshVTK
  ITKIOMeta
  ITKIONIFTI
  ITKIONRRD
  ITKIOPNG
  ITKIOTIFF
  ITKIOTransformBase
  ITKIOTransformInsightLegacy
  ITKIOVTK
  ITKIOXML
  ITKImageAdaptors
  ITKImageCompose
  ITKImageFeature
  ITKImageFilterBase
  ITKImageFunction
  ITKImageGradient
  ITKImageGrid
  ITKImageIntensity
  ITKImageLabel
  ITKImageSources
  ITKImageStatistics
  ITKLabelMap
  ITKMathematicalMorphology
  ITKMesh
  ITKNarrowBand
  ITKOptimizers
  ITKPath
  ITKQuadEdgeMesh
  ITKRegistrationCommon
  ITKSmoothing
  ITKSpatialObjects
  ITKStatistics
  ITKTestKernel
  ITKThresholding
  ITKTransform
  ITKTransformFactory
  ITKVoronoi
)

function(ors_check_itk_modules)
  set(expected ${ORS_ITK_THIRD_PARTY} ${ORS_ITK_OWN})
  set(found ${ITK_MODULES_ENABLED})
  set(unexpected ${found})
  list(REMOVE_ITEM unexpected ${expected})
  set(missing ${expected})
  list(REMOVE_ITEM missing ${found})
  if(unexpected OR missing)
    message(FATAL_ERROR
      "ITK was not built with the modules that are written down (native/cmake/itk_modules.cmake).\n"
      "  built and not written down: ${unexpected}\n"
      "  written down and not built: ${missing}\n"
      "Look at the licence of anything new, then change the list and native/THIRD-PARTY.md.")
  endif()
endfunction()
