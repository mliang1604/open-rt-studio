/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the registration tools share: how their arguments are read, a rigid
// matrix checked and read from a file, elastix's log turned into progress,
// and a region of interest made into a mask.
//
// **Which way.** A matrix here maps the coordinates of a point of the fixed
// volume to those of the moving volume, sixteen numbers row by row, and is
// called `fixedToMoving` wherever it is written down.

#ifndef ors_registration_h
#define ors_registration_h

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <fstream>
#include <iostream>
#include <sstream>
#include <streambuf>
#include <string>
#include <vector>

#include <itkAffineTransform.h>
#include <itkImage.h>
#include <itkImageRegionIteratorWithIndex.h>
#include <itkPoint.h>

#include "ors_common.h"

namespace ors
{

/** A whole number that is not negative and not above `atMost`, or -1. */
inline long
wholeNumber(const std::string & text, long atMost)
{
  if (text.empty() || text.size() > 10)
  {
    return -1;
  }
  for (const char c : text)
  {
    if (c < '0' || c > '9')
    {
      return -1;
    }
  }
  const long value = std::strtol(text.c_str(), nullptr, 10);
  return value <= atMost ? value : -1;
}

/** Numbers separated by commas; empty when one of them is no number. */
inline std::vector<double>
numbers(const std::string & text)
{
  std::vector<double> values;
  std::stringstream   stream(text);
  std::string         item;
  while (std::getline(stream, item, ','))
  {
    char *       end = nullptr;
    const double value = std::strtod(item.c_str(), &end);
    if (item.empty() || end == item.c_str() || *end != '\0' || !std::isfinite(value))
    {
      return {};
    }
    values.push_back(value);
  }
  return values;
}

/**
 * The sixteen numbers of `fixedToMoving` in a JSON file, or nothing. Only
 * as much of JSON is read as the tools themselves write.
 */
inline std::vector<double>
readMatrix(const std::string & path)
{
  std::ifstream file(path, std::ios::binary);
  if (!file)
  {
    return {};
  }
  std::stringstream held;
  held << file.rdbuf();
  const std::string text = held.str();
  const auto        name = text.find("\"fixedToMoving\"");
  if (name == std::string::npos)
  {
    return {};
  }
  const auto open = text.find('[', name);
  const auto close = text.find(']', name);
  if (open == std::string::npos || close == std::string::npos || close < open)
  {
    return {};
  }
  std::string compact;
  for (const char c : text.substr(open + 1, close - open - 1))
  {
    if (c != ' ' && c != '\n' && c != '\r' && c != '\t')
    {
      compact += c;
    }
  }
  const std::vector<double> values = numbers(compact);
  return values.size() == 16 ? values : std::vector<double>{};
}

/** Whether a matrix only turns and moves: its rows are unit vectors at right angles, turning the right way. */
inline bool
isRigid(const std::vector<double> & m)
{
  const double tolerance = 1e-4;
  if (m.size() != 16)
  {
    return false;
  }
  if (std::fabs(m[12]) > tolerance || std::fabs(m[13]) > tolerance || std::fabs(m[14]) > tolerance ||
      std::fabs(m[15] - 1.0) > tolerance)
  {
    return false;
  }
  for (int a = 0; a < 3; ++a)
  {
    for (int b = 0; b < 3; ++b)
    {
      double dot = 0.0;
      for (int k = 0; k < 3; ++k)
      {
        dot += m[4 * a + k] * m[4 * b + k];
      }
      if (std::fabs(dot - (a == b ? 1.0 : 0.0)) > tolerance)
      {
        return false;
      }
    }
  }
  const double determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) +
                             m[2] * (m[4] * m[9] - m[5] * m[8]);
  return determinant > 0.0;
}

using AffineType = itk::AffineTransform<double, 3>;

/** A matrix of sixteen numbers as a transform elastix can start from. */
inline AffineType::Pointer
affineOf(const std::vector<double> & matrix)
{
  AffineType::MatrixType       turn;
  AffineType::OutputVectorType move;
  for (unsigned int row = 0; row < 3; ++row)
  {
    for (unsigned int column = 0; column < 3; ++column)
    {
      turn[row][column] = matrix[4 * row + column];
    }
    move[row] = matrix[4 * row + 3];
  }
  const auto transform = AffineType::New();
  transform->SetMatrix(turn);
  transform->SetTranslation(move);
  return transform;
}

/**
 * A transform as a matrix, read off what it does to four points: no
 * convention of angles or of a centre of rotation is taken on trust. For a
 * transform that does more than a matrix can, this is not it.
 */
template <typename TTransform>
std::vector<double>
matrixOf(const TTransform & transform)
{
  using PointType = itk::Point<double, 3>;
  std::vector<double> matrix(16, 0.0);
  const double        reach = 100.0;
  PointType           zero;
  zero.Fill(0.0);
  const PointType origin = transform.TransformPoint(zero);
  for (unsigned int column = 0; column < 3; ++column)
  {
    PointType along = zero;
    along[column] = reach;
    const PointType mapped = transform.TransformPoint(along);
    for (unsigned int row = 0; row < 3; ++row)
    {
      matrix[4 * row + column] = (mapped[row] - origin[row]) / reach;
    }
  }
  for (unsigned int row = 0; row < 3; ++row)
  {
    matrix[4 * row + 3] = origin[row];
  }
  matrix[15] = 1.0;
  return matrix;
}

/**
 * What elastix logs goes through here in place of standard output. Its
 * lines say which resolution and which iteration it is at, and that is
 * turned into progress for the job, between `from` and `to` of the whole
 * run. The lines themselves are dropped, unless they were asked for.
 */
class LogWatcher : public std::streambuf
{
public:
  LogWatcher(unsigned int resolutions,
             unsigned int iterations,
             double       from,
             double       to,
             const char * doing,
             bool         passOn)
    : m_Resolutions(resolutions > 0 ? resolutions : 1)
    , m_Iterations(iterations > 0 ? iterations : 1)
    , m_From(from)
    , m_To(to)
    , m_Doing(doing)
    , m_PassOn(passOn)
    , m_Reported(from)
  {}

protected:
  int_type
  overflow(int_type c) override
  {
    if (c == traits_type::eof())
    {
      return traits_type::not_eof(c);
    }
    if (c == '\n')
    {
      this->line();
      m_Line.clear();
    }
    else if (m_Line.size() < 4096)
    {
      m_Line += static_cast<char>(c);
    }
    return c;
  }

  std::streamsize
  xsputn(const char * text, std::streamsize count) override
  {
    for (std::streamsize i = 0; i < count; ++i)
    {
      this->overflow(traits_type::to_int_type(text[i]));
    }
    return count;
  }

private:
  void
  line()
  {
    if (m_PassOn && !m_Line.empty())
    {
      // Never a line the job would take for a report of ours.
      std::printf("%s%s\n", m_Line[0] == '@' ? " " : "", m_Line.c_str());
    }
    const std::string resolution = "Resolution: ";
    if (m_Line.compare(0, resolution.size(), resolution) == 0)
    {
      const long level = wholeNumber(m_Line.substr(resolution.size()), 1000);
      if (level >= 0)
      {
        m_Resolution = static_cast<unsigned int>(level);
        this->report(0);
      }
      return;
    }
    // A row of the iteration table begins with the iteration's number.
    const auto tab = m_Line.find('\t');
    if (tab != std::string::npos && tab > 0)
    {
      const long iteration = wholeNumber(m_Line.substr(0, tab), 1000000);
      if (iteration >= 0)
      {
        this->report(static_cast<unsigned int>(iteration) + 1);
      }
    }
  }

  void
  report(unsigned int iterationsDone)
  {
    const double steps = static_cast<double>(m_Resolutions) * static_cast<double>(m_Iterations);
    double       done = static_cast<double>(m_Resolution) * static_cast<double>(m_Iterations) + iterationsDone;
    done = done > steps ? steps : done;
    const double fraction = m_From + (m_To - m_From) * (done / steps);
    // Not every iteration: a line for each hundredth of the way.
    if (fraction >= m_Reported + 0.01)
    {
      m_Reported = fraction;
      ors::progress(fraction, m_Doing);
    }
  }

  std::string  m_Line;
  unsigned int m_Resolutions;
  unsigned int m_Iterations;
  double       m_From;
  double       m_To;
  const char * m_Doing;
  bool         m_PassOn;
  unsigned int m_Resolution = 0;
  double       m_Reported;
};

/** Puts std::cout through a watcher for as long as it lives. */
class WatchedLog
{
public:
  explicit WatchedLog(LogWatcher & watcher)
    : m_Before(std::cout.rdbuf(&watcher))
  {}
  ~WatchedLog() { std::cout.rdbuf(m_Before); }
  WatchedLog(const WatchedLog &) = delete;
  WatchedLog &
  operator=(const WatchedLog &) = delete;

private:
  std::streambuf * m_Before;
};

/** A volume a tool can read, or a null pointer with the failure said and its status in `status`. */
inline VolumeType::Pointer
volumeOrFail(const std::string & path, const char * code, bool verbose, int & status)
{
  try
  {
    const char *                    problem = nullptr;
    const itk::ImageIOBase::Pointer io = openVolume(path, problem);
    if (io.IsNull())
    {
      status = fail(STATUS_UNREADABLE, code, problem);
      return nullptr;
    }
    return readVolume(path, io);
  }
  catch (const std::exception & problem)
  {
    status = fail(STATUS_UNREADABLE, code, verbose ? problem.what() : "");
    return nullptr;
  }
}

using MaskType = itk::Image<unsigned char, 3>;

/**
 * A box in the fixed volume's coordinates (two opposite corners, six
 * numbers) as a mask on the fixed volume's grid; null when next to nothing
 * of the volume is inside.
 */
inline MaskType::Pointer
boxMask(const VolumeType & fixed, const std::vector<double> & roi)
{
  double low[3], high[3];
  for (int axis = 0; axis < 3; ++axis)
  {
    low[axis] = roi[axis] < roi[axis + 3] ? roi[axis] : roi[axis + 3];
    high[axis] = roi[axis] < roi[axis + 3] ? roi[axis + 3] : roi[axis];
  }
  const auto mask = MaskType::New();
  mask->SetRegions(fixed.GetLargestPossibleRegion());
  mask->SetSpacing(fixed.GetSpacing());
  mask->SetOrigin(fixed.GetOrigin());
  mask->SetDirection(fixed.GetDirection());
  mask->Allocate();

  std::size_t                                 inside = 0;
  itk::ImageRegionIteratorWithIndex<MaskType> voxel(mask, mask->GetLargestPossibleRegion());
  for (voxel.GoToBegin(); !voxel.IsAtEnd(); ++voxel)
  {
    MaskType::PointType point;
    mask->TransformIndexToPhysicalPoint(voxel.GetIndex(), point);
    const bool within = point[0] >= low[0] && point[0] <= high[0] && point[1] >= low[1] && point[1] <= high[1] &&
                        point[2] >= low[2] && point[2] <= high[2];
    voxel.Set(within ? 1 : 0);
    inside += within ? 1 : 0;
  }
  // A handful of voxels is nothing to register on.
  return inside >= 1000 ? mask : nullptr;
}

} // namespace ors

#endif
